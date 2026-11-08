import type { Actor } from "../../../shared/actor.js";
import type { Clock } from "../../../shared/clock.js";
import type { Telemetry } from "../../../shared/telemetry.js";
import { type Booking, BookingErrors, cancelBooking } from "../domain/booking.js";
import { bookingEvent, type BookingEventPublisher } from "../domain/booking-events.js";
import type { BookingRepository } from "../domain/booking-repository.js";
import { publishSafely } from "./publish-safely.js";

export class CancelBooking {
  constructor(
    private readonly bookings: BookingRepository,
    private readonly publisher: BookingEventPublisher,
    private readonly telemetry: Telemetry,
    private readonly clock: Clock,
  ) {}

  async execute(actor: Actor, eventId: string, bookingId: string): Promise<Booking> {
    const booking = await this.bookings.findById(eventId, bookingId);
    if (booking === undefined) throw BookingErrors.notFound();

    const cancelled = cancelBooking(booking, actor.userId, this.clock.now());
    await this.bookings.cancel(cancelled);

    this.telemetry.count("BookingCancelled");
    await publishSafely(this.publisher, this.telemetry, bookingEvent("BookingCancelled", cancelled, this.clock.now()));
    return cancelled;
  }
}
