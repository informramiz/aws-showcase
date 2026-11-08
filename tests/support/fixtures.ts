import { Logger } from "@aws-lambda-powertools/logger";
import type { Actor } from "../../src/shared/actor.js";
import { Role } from "../../src/shared/actor.js";
import type { Clock } from "../../src/shared/clock.js";
import type { IdGenerator } from "../../src/shared/ids.js";
import type { Telemetry } from "../../src/shared/telemetry.js";
import type { Event } from "../../src/features/events/domain/event.js";
import type { Booking } from "../../src/features/bookings/domain/booking.js";

export const NOW = new Date("2030-01-01T12:00:00.000Z");
export const LATER = "2030-02-01T18:00:00.000Z";

export const fixedClock = (now: Date = NOW): Clock & { set(d: Date): void } => {
  let current = now;
  return { now: () => current, set: (d) => (current = d) };
};

export const sequentialIds = (prefix = "00000000-0000-4000-8000-"): IdGenerator => {
  let n = 0;
  return { next: () => `${prefix}${String(++n).padStart(12, "0")}` };
};

export const organizer = (userId = "org-1"): Actor => ({ userId, roles: new Set([Role.Organizer]) });
export const attendee = (userId = "user-1"): Actor => ({ userId, roles: new Set([Role.Attendee]) });

export const anEvent = (overrides: Partial<Event> = {}): Event => ({
  id: "11111111-1111-4111-8111-111111111111",
  title: "TypeScript Summit",
  venue: "Hall A",
  startsAt: LATER,
  capacity: 100,
  seatsRemaining: 100,
  organizerId: "org-1",
  createdAt: NOW.toISOString(),
  ...overrides,
});

export const aBooking = (overrides: Partial<Booking> = {}): Booking => ({
  id: "22222222-2222-4222-8222-222222222222",
  eventId: "11111111-1111-4111-8111-111111111111",
  userId: "user-1",
  seats: 2,
  status: "CONFIRMED",
  createdAt: NOW.toISOString(),
  eventTitle: "TypeScript Summit",
  eventStartsAt: LATER,
  ...overrides,
});

export interface RecordingTelemetry extends Telemetry {
  readonly counts: Map<string, number>;
  readonly errors: { message: string; error: unknown }[];
}

export const recordingTelemetry = (): RecordingTelemetry => {
  const counts = new Map<string, number>();
  const errors: { message: string; error: unknown }[] = [];
  return {
    counts,
    errors,
    count: (metric, value = 1) => counts.set(metric, (counts.get(metric) ?? 0) + value),
    error: (message, error) => errors.push({ message, error }),
  };
};

export const silentLogger = (): Logger => new Logger({ serviceName: "test", logLevel: "SILENT" });
