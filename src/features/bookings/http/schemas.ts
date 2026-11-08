import { z } from "zod";
import { MAX_SEATS_PER_BOOKING, type Booking } from "../domain/booking.js";

export const bookSeatsBody = z.strictObject({
  seats: z.number().int().min(1).max(MAX_SEATS_PER_BOOKING),
});

/** Client-chosen key, 8-128 printable characters (a UUID is the expected choice). */
export const idempotencyKeyHeader = z
  .string({ error: "Idempotency-Key header is required" })
  .regex(/^[\x21-\x7E]{8,128}$/, "Idempotency-Key must be 8-128 printable ASCII characters");

export const bookingPathParams = z.object({ eventId: z.uuid(), bookingId: z.uuid() });

export const toBookingDto = (b: Booking) => ({
  id: b.id,
  eventId: b.eventId,
  seats: b.seats,
  status: b.status,
  createdAt: b.createdAt,
  cancelledAt: b.cancelledAt ?? null,
  event: { title: b.eventTitle, startsAt: b.eventStartsAt },
});
