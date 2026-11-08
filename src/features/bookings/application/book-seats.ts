import { type Actor, hasRole, Role } from "../../../shared/actor.js";
import type { Clock } from "../../../shared/clock.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import type { IdGenerator } from "../../../shared/ids.js";
import type { Telemetry } from "../../../shared/telemetry.js";
import type { EventRepository } from "../../events/domain/event-repository.js";
import { type Booking, requestBooking } from "../domain/booking.js";
import { bookingEvent, type BookingEventPublisher } from "../domain/booking-events.js";
import type { BookingRepository } from "../domain/booking-repository.js";
import { publishSafely } from "./publish-safely.js";

export interface BookSeatsCommand {
  readonly eventId: string;
  readonly seats: number;
}

export class BookSeats {
  constructor(
    private readonly events: EventRepository,
    private readonly bookings: BookingRepository,
    private readonly publisher: BookingEventPublisher,
    private readonly telemetry: Telemetry,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(actor: Actor, { eventId, seats }: BookSeatsCommand): Promise<Booking> {
    if (!hasRole(actor, Role.Attendee)) throw new ForbiddenError("ATTENDEE_ONLY", "Only attendees can book seats");
    const event = await this.events.findById(eventId);
    if (event === undefined) throw new NotFoundError("EVENT_NOT_FOUND", "Event not found");

    const booking = requestBooking({ id: this.ids.next(), event, userId: actor.userId, seats, now: this.clock.now() });
    try {
      await this.bookings.confirm(booking);
    } catch (error) {
      if (error instanceof ConflictError && error.code === "SOLD_OUT") this.telemetry.count("BookingRejectedSoldOut");
      throw error;
    }

    this.telemetry.count("BookingConfirmed");
    this.telemetry.count("SeatsBooked", booking.seats);
    await publishSafely(this.publisher, this.telemetry, bookingEvent("BookingConfirmed", booking, this.clock.now()));
    return booking;
  }
}
