import { BusinessRuleError, ConflictError, NotFoundError } from "../../../shared/errors.js";
import type { EventPublisher, IntegrationEvent } from "../../../shared/events/integration-event.js";
import { type Event, hasStarted } from "../../events/domain/event.js";

/**
 * WAITING: in the queue. OFFERED: a held seat is reserved for this user until `offerExpiresAt`.
 * ACCEPTED: the user took the seat (a booking exists). EXPIRED: the hold ran out; the user may join again.
 */
export type WaitlistStatus = "WAITING" | "OFFERED" | "ACCEPTED" | "EXPIRED";

/** How long an offered seat is held before it moves on to the next person (15 minutes). */
export const DEFAULT_HOLD_SECONDS = 900;

export interface WaitlistEntry {
  readonly eventId: string;
  readonly userId: string;
  readonly status: WaitlistStatus;
  readonly joinedAt: string;
  readonly offerExpiresAt?: string;
}

export const WaitlistErrors = {
  seatsAvailable: () => new ConflictError("SEATS_AVAILABLE", "Seats are still available; book one instead"),
  alreadyWaitlisted: () => new ConflictError("ALREADY_WAITLISTED", "You are already on the waitlist for this event"),
  alreadyBooked: () => new ConflictError("ALREADY_BOOKED", "You already have a booking for this event"),
  noOffer: () => new NotFoundError("NO_OFFER", "You have no seat offer for this event"),
  offerExpired: () => new ConflictError("OFFER_EXPIRED", "The seat offer has expired"),
  eventStarted: () => new BusinessRuleError("EVENT_STARTED", "The event has already started"),
} as const;

/**
 * Puts a user in the queue. Only a sold-out event has a waitlist; the repository re-checks that (and
 * that the user holds no booking) inside the same transaction, so this is the fast path for errors.
 */
export const joinWaitlist = (event: Event, userId: string, now: Date): WaitlistEntry => {
  if (hasStarted(event, now)) throw WaitlistErrors.eventStarted();
  if (event.seatsRemaining > 0) throw WaitlistErrors.seatsAvailable();
  return { eventId: event.id, userId, status: "WAITING", joinedAt: now.toISOString() };
};

/** Checks that `entry` holds a live offer at `now`. The repository enforces the same with a condition. */
export function assertOfferOpen(entry: WaitlistEntry | undefined, now: Date): asserts entry is WaitlistEntry {
  if (entry?.status !== "OFFERED" || entry.offerExpiresAt === undefined) throw WaitlistErrors.noOffer();
  if (Date.parse(entry.offerExpiresAt) <= now.getTime()) throw WaitlistErrors.offerExpired();
}

/** Published when a held seat is offered; the notifier tells the user to accept before it expires. */
export interface WaitlistSeatOffered extends IntegrationEvent {
  readonly type: "WaitlistSeatOffered";
  readonly eventId: string;
  readonly userId: string;
  readonly offerExpiresAt: string;
}

export type WaitlistEventPublisher = EventPublisher<WaitlistSeatOffered>;

/** Result of offering the next freed seat: nobody left in the queue, or who got it and until when. */
export type OfferResult =
  { readonly offered: false } | { readonly offered: true; readonly userId: string; readonly offerExpiresAt: string };

export type OfferResolution = "accepted" | "expired";
