import type { StreamChange } from "../../../shared/dynamodb/stream.js";
import type { SeatRelease } from "../domain/seat-release-workflow.js";

/**
 * A booking item that went CONFIRMED -> CANCELLED. The stream is the trigger (not the
 * `BookingCancelled` event) because it is written atomically with the cancellation; the event is
 * best-effort after commit and could be lost.
 */
export const toSeatRelease = (change: StreamChange): SeatRelease | undefined => {
  const before = change.oldImage;
  const after = change.newImage;
  if (change.kind !== "MODIFY" || after?.["type"] !== "Booking") return undefined;
  if (before?.["status"] !== "CONFIRMED" || after["status"] !== "CANCELLED") return undefined;
  const { id, eventId, seats } = after;
  if (typeof id !== "string" || typeof eventId !== "string" || typeof seats !== "number") return undefined;
  return { bookingId: id, eventId, seats };
};
