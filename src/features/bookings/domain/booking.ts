import { BusinessRuleError, ConflictError, NotFoundError } from "../../../shared/errors.js";
import { type Event, hasStarted } from "../../events/domain/event.js";

export const MAX_SEATS_PER_BOOKING = 10;

export type BookingStatus = "CONFIRMED" | "CANCELLED";

export interface Booking {
  readonly id: string;
  readonly eventId: string;
  readonly userId: string;
  readonly seats: number;
  readonly status: BookingStatus;
  readonly createdAt: string;
  readonly cancelledAt?: string;
  /** Denormalised so "my bookings" is one query with no join. Event title and start never change. */
  readonly eventTitle: string;
  readonly eventStartsAt: string;
}

export const BookingErrors = {
  eventStarted: () => new BusinessRuleError("EVENT_STARTED", "The event has already started"),
  soldOut: () => new ConflictError("SOLD_OUT", "Not enough seats left for this booking"),
  alreadyBooked: () => new ConflictError("ALREADY_BOOKED", "You already have a booking for this event"),
  alreadyCancelled: () => new ConflictError("ALREADY_CANCELLED", "This booking is already cancelled"),
  notFound: () => new NotFoundError("BOOKING_NOT_FOUND", "Booking not found"),
  tooManySeats: () => new BusinessRuleError("TOO_MANY_SEATS", `A booking can hold 1 to ${MAX_SEATS_PER_BOOKING} seats`),
} as const;

export interface BookingRequest {
  readonly id: string;
  readonly event: Event;
  readonly userId: string;
  readonly seats: number;
  readonly now: Date;
}

/**
 * Creates a confirmed booking if the domain rules allow it. The seat check here is only a fast path
 * for a clear error; the guarantee against overselling is the conditional write in the repository.
 */
export const requestBooking = ({ id, event, userId, seats, now }: BookingRequest): Booking => {
  if (!Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS_PER_BOOKING) throw BookingErrors.tooManySeats();
  if (hasStarted(event, now)) throw BookingErrors.eventStarted();
  if (seats > event.seatsRemaining) throw BookingErrors.soldOut();
  return {
    id,
    eventId: event.id,
    userId,
    seats,
    status: "CONFIRMED",
    createdAt: now.toISOString(),
    eventTitle: event.title,
    eventStartsAt: event.startsAt,
  };
};

/**
 * Cancels a booking on behalf of `userId`. Someone else's booking is reported as not found so the API
 * does not reveal which booking IDs exist.
 */
export const cancelBooking = (booking: Booking, userId: string, now: Date): Booking => {
  if (booking.userId !== userId) throw BookingErrors.notFound();
  if (booking.status === "CANCELLED") throw BookingErrors.alreadyCancelled();
  if (hasStarted({ startsAt: booking.eventStartsAt }, now)) throw BookingErrors.eventStarted();
  return { ...booking, status: "CANCELLED", cancelledAt: now.toISOString() };
};
