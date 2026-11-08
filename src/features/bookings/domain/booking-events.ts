import type { EventPublisher, IntegrationEvent } from "../../../shared/events/integration-event.js";
import type { Booking } from "./booking.js";

export type BookingEventType = "BookingConfirmed" | "BookingCancelled";

/** Integration event published after a booking change commits. Carries IDs and facts, no PII. */
export interface BookingEvent extends IntegrationEvent {
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

export type BookingEventPublisher = EventPublisher<BookingEvent>;
