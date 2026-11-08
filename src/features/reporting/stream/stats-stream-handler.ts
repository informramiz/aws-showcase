import { type Item, makeStreamHandler, type StreamChange } from "../../../shared/dynamodb/stream.js";
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

/** Stats projector: records are processed in order because a batch usually hits one STATS item. */
export const makeStatsStreamHandler = (useCase: ProjectEventStats) =>
  makeStreamHandler(async (change) => {
    const tracked = toTrackedChange(change);
    if (tracked !== undefined) await useCase.execute(change.id, tracked, change.at);
  });
