import type { BookingStatus } from "../../bookings/domain/booking.js";
import type { WaitlistStatus } from "../../waitlist/domain/waitlist.js";

export const STAT_COUNTERS = [
  "bookingsConfirmed",
  "bookingsCancelled",
  "seatsBooked",
  "waitlistJoined",
  "waitlistWaiting",
  "offersMade",
  "offersAccepted",
  "offersExpired",
] as const;

export type StatCounter = (typeof STAT_COUNTERS)[number];
export type StatsDelta = Partial<Record<StatCounter, number>>;

/** Organizer-facing counters for one event, maintained from the table's change stream. */
export type EventStats = Readonly<Record<StatCounter, number>> & {
  readonly eventId: string;
  /** When the last counted change happened; absent while nothing has been counted. */
  readonly updatedAt?: string;
};

export const emptyStats = (eventId: string): EventStats => ({
  eventId,
  ...(Object.fromEntries(STAT_COUNTERS.map((c) => [c, 0])) as Record<StatCounter, number>),
});

/** A status transition of a booking or waitlist entry. `from` is absent on create, `to` on delete. */
export type TrackedChange =
  | {
      readonly entity: "booking";
      readonly eventId: string;
      readonly seats: number;
      readonly from?: BookingStatus;
      readonly to?: BookingStatus;
    }
  | {
      readonly entity: "waitlist";
      readonly eventId: string;
      readonly from?: WaitlistStatus;
      readonly to?: WaitlistStatus;
    };

const bookingDelta = (from: BookingStatus | undefined, to: BookingStatus | undefined, seats: number): StatsDelta => {
  if (from === undefined && to === "CONFIRMED") return { bookingsConfirmed: 1, seatsBooked: seats };
  if (from === "CONFIRMED" && to === "CANCELLED") return { bookingsCancelled: 1, seatsBooked: -seats };
  return {};
};

const waitlistDelta = (from: WaitlistStatus | undefined, to: WaitlistStatus | undefined): StatsDelta => {
  if (from === to) return {};
  if (to === "WAITING") return { waitlistJoined: 1, waitlistWaiting: 1 };
  if (from === "WAITING" && to === "OFFERED") return { waitlistWaiting: -1, offersMade: 1 };
  if (from === "WAITING") return { waitlistWaiting: -1 };
  if (from === "OFFERED" && to === "ACCEPTED") return { offersAccepted: 1 };
  if (from === "OFFERED" && to === "EXPIRED") return { offersExpired: 1 };
  return {};
};

/** What a change adds to the counters. An empty delta means the change is not counted (e.g. a no-op update). */
export const deltaFor = (change: TrackedChange): StatsDelta =>
  change.entity === "booking"
    ? bookingDelta(change.from, change.to, change.seats)
    : waitlistDelta(change.from, change.to);

export const isEmptyDelta = (delta: StatsDelta): boolean => Object.values(delta).every((v) => v === 0);
