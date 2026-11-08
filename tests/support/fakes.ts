import { ConflictError, NotFoundError } from "../../src/shared/errors.js";
import type { Page, PageRequest } from "../../src/shared/page.js";
import { type Event, hasStarted } from "../../src/features/events/domain/event.js";
import type { AttachImageResult, EventRepository } from "../../src/features/events/domain/event-repository.js";
import type { EventImage } from "../../src/features/events/domain/event-image.js";
import type {
  ImageStore,
  ImageUploadSigner,
  UploadUrlRequest,
} from "../../src/features/events/domain/image-storage.js";
import { type Booking, BookingErrors } from "../../src/features/bookings/domain/booking.js";
import type { BookingRepository } from "../../src/features/bookings/domain/booking-repository.js";
import type { BookingEvent } from "../../src/features/bookings/domain/booking-events.js";
import {
  assertOfferOpen,
  type OfferResolution,
  type OfferResult,
  type WaitlistEntry,
  WaitlistErrors,
} from "../../src/features/waitlist/domain/waitlist.js";
import type { WaitlistRepository } from "../../src/features/waitlist/domain/waitlist-repository.js";
import type {
  BatchEventPublisher,
  EventPublisher,
  IntegrationEvent,
} from "../../src/shared/events/integration-event.js";
import { emptyStats, type EventStats, type StatsDelta } from "../../src/features/reporting/domain/event-stats.js";
import type { ApplyResult, StatsRepository } from "../../src/features/reporting/domain/stats-repository.js";

const paginate = <T>(all: T[], page: PageRequest): Page<T> => {
  const start = page.cursor === undefined ? 0 : Number(page.cursor);
  const items = all.slice(start, start + page.limit);
  const next = start + page.limit;
  return next < all.length ? { items, nextCursor: String(next) } : { items };
};

/** In-memory event store with the same contract as the DynamoDB adapter. */
export class InMemoryEventRepository implements EventRepository {
  readonly events = new Map<string, Event>();

  create(event: Event): Promise<void> {
    if (this.events.has(event.id)) return Promise.reject(new ConflictError("DUPLICATE", "exists"));
    this.events.set(event.id, event);
    return Promise.resolve();
  }

  findById(eventId: string): Promise<Event | undefined> {
    return Promise.resolve(this.events.get(eventId));
  }

  listUpcoming(from: Date, page: PageRequest): Promise<Page<Event>> {
    const upcoming = [...this.events.values()]
      .filter((e) => Date.parse(e.startsAt) >= from.getTime())
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return Promise.resolve(paginate(upcoming, page));
  }

  attachImage(eventId: string, image: EventImage): Promise<AttachImageResult> {
    const event = this.events.get(eventId);
    if (event === undefined) return Promise.resolve({ status: "event_not_found" });
    const replaced = event.image;
    if (replaced !== undefined && replaced.uploadedAt > image.uploadedAt) return Promise.resolve({ status: "stale" });
    this.events.set(eventId, { ...event, image });
    return Promise.resolve({ status: "attached", ...(replaced === undefined ? {} : { replaced }) });
  }
}

/** Object store fake: keys map to their bytes. */
export class InMemoryImageStore implements ImageStore {
  readonly objects = new Map<string, Uint8Array>();

  readHeader(key: string, bytes: number): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.objects.get(key)?.slice(0, bytes));
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}

export class RecordingSigner implements ImageUploadSigner {
  readonly requests: UploadUrlRequest[] = [];

  presignPut(request: UploadUrlRequest): Promise<string> {
    this.requests.push(request);
    return Promise.resolve(`https://bucket.s3.amazonaws.com/${request.key}?X-Amz-Signature=sig`);
  }
}

/** In-memory booking store that keeps the event's seat count in step, like the transaction does. */
export class InMemoryBookingRepository implements BookingRepository {
  readonly bookings = new Map<string, Booking>();
  private readonly attendees = new Set<string>();

  constructor(private readonly events: InMemoryEventRepository) {}

  confirm(booking: Booking): Promise<void> {
    const event = this.events.events.get(booking.eventId);
    if (event === undefined) return Promise.reject(new NotFoundError("EVENT_NOT_FOUND", "Event not found"));
    if (event.seatsRemaining < booking.seats) return Promise.reject(BookingErrors.soldOut());
    const attendeeKey = `${booking.eventId}#${booking.userId}`;
    if (this.attendees.has(attendeeKey)) return Promise.reject(BookingErrors.alreadyBooked());
    this.attendees.add(attendeeKey);
    this.events.events.set(event.id, { ...event, seatsRemaining: event.seatsRemaining - booking.seats });
    this.bookings.set(booking.id, booking);
    return Promise.resolve();
  }

  cancel(booking: Booking): Promise<void> {
    const stored = this.bookings.get(booking.id);
    if (stored?.status !== "CONFIRMED") return Promise.reject(BookingErrors.alreadyCancelled());
    const event = this.events.events.get(booking.eventId);
    if (event === undefined) return Promise.reject(new NotFoundError("EVENT_NOT_FOUND", "Event not found"));
    this.events.events.set(event.id, { ...event, seatsRemaining: event.seatsRemaining + booking.seats });
    this.attendees.delete(`${booking.eventId}#${booking.userId}`);
    this.bookings.set(booking.id, booking);
    return Promise.resolve();
  }

  findById(eventId: string, bookingId: string): Promise<Booking | undefined> {
    const b = this.bookings.get(bookingId);
    return Promise.resolve(b?.eventId === eventId ? b : undefined);
  }

  listByUser(userId: string, page: PageRequest): Promise<Page<Booking>> {
    const mine = [...this.bookings.values()]
      .filter((b) => b.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Promise.resolve(paginate(mine, page));
  }
}

/** Records published events; set `failWith` to make every publish reject. */
export class RecordingPublisher<E extends IntegrationEvent = BookingEvent>
  implements EventPublisher<E>, BatchEventPublisher<E>
{
  readonly published: E[] = [];
  failWith: Error | undefined;

  publish(event: E): Promise<void> {
    return this.publishAll([event]);
  }

  publishAll(events: readonly E[]): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.published.push(...events);
    return Promise.resolve();
  }
}

/** Waitlist fake over the event fake, keeping the seat count in step like the transactions do. */
export class InMemoryWaitlistRepository implements WaitlistRepository {
  readonly entries = new Map<string, WaitlistEntry>();
  readonly bookings: Booking[] = [];

  constructor(private readonly events: InMemoryEventRepository) {}

  private key = (eventId: string, userId: string) => `${eventId}#${userId}`;

  private adjustSeats(eventId: string, by: number): void {
    const event = this.events.events.get(eventId);
    if (event !== undefined) this.events.events.set(eventId, { ...event, seatsRemaining: event.seatsRemaining + by });
  }

  join(entry: WaitlistEntry): Promise<void> {
    const event = this.events.events.get(entry.eventId);
    if (event === undefined) return Promise.reject(new NotFoundError("EVENT_NOT_FOUND", "Event not found"));
    if (event.seatsRemaining > 0) return Promise.reject(WaitlistErrors.seatsAvailable());
    const existing = this.entries.get(this.key(entry.eventId, entry.userId));
    if (existing?.status === "WAITING" || existing?.status === "OFFERED") {
      return Promise.reject(WaitlistErrors.alreadyWaitlisted());
    }
    this.entries.set(this.key(entry.eventId, entry.userId), entry);
    return Promise.resolve();
  }

  find(eventId: string, userId: string): Promise<WaitlistEntry | undefined> {
    return Promise.resolve(this.entries.get(this.key(eventId, userId)));
  }

  offerNext(eventId: string, now: Date, offerExpiresAt: Date): Promise<OfferResult> {
    const event = this.events.events.get(eventId);
    const next = [...this.entries.values()]
      .filter((e) => e.eventId === eventId && e.status === "WAITING")
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0];
    if (next === undefined || event === undefined || event.seatsRemaining < 1 || hasStarted(event, now)) {
      return Promise.resolve({ offered: false });
    }
    this.adjustSeats(eventId, -1);
    const expires = offerExpiresAt.toISOString();
    this.entries.set(this.key(eventId, next.userId), { ...next, status: "OFFERED", offerExpiresAt: expires });
    return Promise.resolve({ offered: true, userId: next.userId, offerExpiresAt: expires });
  }

  accept(eventId: string, userId: string, booking: Booking, now: Date): Promise<void> {
    const entry = this.entries.get(this.key(eventId, userId));
    try {
      assertOfferOpen(entry, now);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.entries.set(this.key(eventId, userId), { ...entry, status: "ACCEPTED" });
    this.bookings.push(booking);
    return Promise.resolve();
  }

  resolve(eventId: string, userId: string): Promise<OfferResolution> {
    const entry = this.entries.get(this.key(eventId, userId));
    if (entry?.status === "ACCEPTED") return Promise.resolve("accepted");
    if (entry?.status === "OFFERED") {
      this.entries.set(this.key(eventId, userId), { ...entry, status: "EXPIRED" });
      this.adjustSeats(eventId, 1);
    }
    return Promise.resolve("expired");
  }
}

/** Stats store fake with the same exactly-once-per-change contract as the DynamoDB adapter. */
export class InMemoryStatsRepository implements StatsRepository {
  readonly stats = new Map<string, EventStats>();
  readonly seen = new Set<string>();

  apply(changeId: string, eventId: string, delta: StatsDelta, at: string): Promise<ApplyResult> {
    if (this.seen.has(changeId)) return Promise.resolve("duplicate");
    this.seen.add(changeId);
    const current: Record<string, unknown> = { ...(this.stats.get(eventId) ?? emptyStats(eventId)), updatedAt: at };
    for (const [counter, value] of Object.entries(delta)) current[counter] = (current[counter] as number) + value;
    this.stats.set(eventId, current as EventStats);
    return Promise.resolve("applied");
  }

  get(eventId: string): Promise<EventStats | undefined> {
    return Promise.resolve(this.stats.get(eventId));
  }
}
