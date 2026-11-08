import type { Booking } from "../../bookings/domain/booking.js";
import type { OfferResolution, OfferResult, WaitlistEntry } from "./waitlist.js";

/** Waitlist persistence. Every state change is one conditional transaction with the seat count. */
export interface WaitlistRepository {
  /** Adds the entry if the event is still sold out and the user has no booking or open entry. */
  join(entry: WaitlistEntry): Promise<void>;
  find(eventId: string, userId: string): Promise<WaitlistEntry | undefined>;
  /**
   * Takes one free seat off the event and offers it to the person at the head of the queue, holding
   * it until `offerExpiresAt`. Offers nothing if the queue is empty, the seat was taken by a direct
   * booking in the meantime, or the event has started.
   */
  offerNext(eventId: string, now: Date, offerExpiresAt: Date): Promise<OfferResult>;
  /** Turns an open offer into a one-seat booking. The held seat is already off the count. */
  accept(eventId: string, userId: string, booking: Booking, now: Date): Promise<void>;
  /** After the hold: ACCEPTED stays; a still-open offer expires and its seat goes back on the count. */
  resolve(eventId: string, userId: string, now: Date): Promise<OfferResolution>;
}
