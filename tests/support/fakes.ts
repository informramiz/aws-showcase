import { ConflictError, NotFoundError } from "../../src/shared/errors.js";
import type { Page, PageRequest } from "../../src/shared/page.js";
import type { Event } from "../../src/features/events/domain/event.js";
import type { AttachImageResult, EventRepository } from "../../src/features/events/domain/event-repository.js";
import type { EventImage } from "../../src/features/events/domain/event-image.js";
import type {
  ImageStore,
  ImageUploadSigner,
  UploadUrlRequest,
} from "../../src/features/events/domain/image-storage.js";
import { type Booking, BookingErrors } from "../../src/features/bookings/domain/booking.js";
import type { BookingRepository } from "../../src/features/bookings/domain/booking-repository.js";
import type { BookingEvent, BookingEventPublisher } from "../../src/features/bookings/domain/booking-events.js";

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

export class RecordingPublisher implements BookingEventPublisher {
  readonly published: BookingEvent[] = [];
  failWith: Error | undefined;

  publish(event: BookingEvent): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.published.push(event);
    return Promise.resolve();
  }
}
