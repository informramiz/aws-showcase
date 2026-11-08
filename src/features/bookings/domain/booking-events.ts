import type { Booking } from "./booking.js";

export const BOOKING_EVENT_SOURCE = "bookings-api";

export type BookingEventType = "BookingConfirmed" | "BookingCancelled";

/** Integration event published after a booking change commits. Carries IDs and facts, no PII. */
export interface BookingEvent {
  readonly type: BookingEventType;
  readonly bookingId: string;
  readonly eventId: string;
  readonly userId: string;
  readonly seats: number;
  readonly occurredAt: string;
}

export const bookingEvent = (type: BookingEventType, booking: Booking, occurredAt: Date): BookingEvent => ({
  type,
  bookingId: booking.id,
  eventId: booking.eventId,
  userId: booking.userId,
  seats: booking.seats,
  occurredAt: occurredAt.toISOString(),
});

export interface BookingEventPublisher {
  publish(event: BookingEvent): Promise<void>;
}
