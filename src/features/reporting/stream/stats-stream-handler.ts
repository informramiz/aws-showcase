import { BatchProcessor, EventType, processPartialResponse } from "@aws-lambda-powertools/batch";
import type { Context, DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { type Item, type StreamChange, toStreamChange } from "../../../shared/dynamodb/stream.js";
import type { BookingStatus } from "../../bookings/domain/booking.js";
import type { WaitlistStatus } from "../../waitlist/domain/waitlist.js";
import type { ProjectEventStats } from "../application/project-event-stats.js";
import type { TrackedChange } from "../domain/event-stats.js";

const str = (item: Item | undefined, key: string): string | undefined => {
  const value = item?.[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * Maps a raw table change to a domain transition. Only booking and waitlist items are tracked; the
 * stream event filter already drops everything else, this is the second line of defence.
 */
export const toTrackedChange = (change: StreamChange): TrackedChange | undefined => {
  const current = change.newImage ?? change.oldImage;
  const type = str(current, "type");
  const eventId = str(current, "eventId");
  if (eventId === undefined) return undefined;
  const from = str(change.oldImage, "status");
  const to = str(change.newImage, "status");
  const transition = { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
  if (type === "Booking") {
    const seats = current?.["seats"];
    if (typeof seats !== "number") return undefined;
    return { entity: "booking", eventId, seats, ...(transition as { from?: BookingStatus; to?: BookingStatus }) };
  }
  if (type === "WaitlistEntry") {
    return { entity: "waitlist", eventId, ...(transition as { from?: WaitlistStatus; to?: WaitlistStatus }) };
  }
  return undefined;
};

/**
 * DynamoDB Streams batch handler with partial batch responses: a failed record is reported back so
 * Lambda retries from it (with bisecting) instead of replaying the whole batch. Records are processed
 * one at a time because several changes in a batch usually hit the same event's STATS item.
 */
export const makeStatsStreamHandler = (useCase: ProjectEventStats) => {
  const processor = new BatchProcessor(EventType.DynamoDBStreams);
  const recordHandler = async (record: DynamoDBRecord): Promise<void> => {
    const change = toStreamChange(record);
    const tracked = toTrackedChange(change);
    if (tracked !== undefined) await useCase.execute(change.id, tracked, change.at);
  };
  return (event: DynamoDBStreamEvent, context: Context): Promise<DynamoDBBatchResponse> =>
    processPartialResponse(event, recordHandler, processor, { context, processInParallel: false });
};
