import type { Actor } from "../../../shared/actor.js";
import type { Clock } from "../../../shared/clock.js";
import { publishSafely } from "../../../shared/events/publish-safely.js";
import type { IdGenerator } from "../../../shared/ids.js";
import type { Telemetry } from "../../../shared/telemetry.js";
import type { Booking } from "../../bookings/domain/booking.js";
import { bookingEvent, type BookingEventPublisher } from "../../bookings/domain/booking-events.js";
import type { EventRepository } from "../../events/domain/event-repository.js";
import { assertOfferOpen } from "../domain/waitlist.js";
import type { WaitlistRepository } from "../domain/waitlist-repository.js";

/** A waitlisted user takes the seat held for them. The result is an ordinary one-seat booking. */
export class AcceptOffer {
  constructor(
    private readonly events: EventRepository,
    private readonly waitlist: WaitlistRepository,
    private readonly publisher: BookingEventPublisher,
    private readonly telemetry: Telemetry,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(actor: Actor, eventId: string): Promise<Booking> {
    const now = this.clock.now();
    assertOfferOpen(await this.waitlist.find(eventId, actor.userId), now);
    const event = await this.events.findById(eventId);
    if (event === undefined) throw new Error(`Event ${eventId} missing for an open waitlist offer`);

    const booking: Booking = {
      id: this.ids.next(),
      eventId,
      userId: actor.userId,
      seats: 1,
      status: "CONFIRMED",
      createdAt: now.toISOString(),
      eventTitle: event.title,
      eventStartsAt: event.startsAt,
    };
    await this.waitlist.accept(eventId, actor.userId, booking, now);

    this.telemetry.count("WaitlistOfferAccepted");
    await publishSafely(this.publisher, this.telemetry, bookingEvent("BookingConfirmed", booking, now));
    return booking;
  }
}
