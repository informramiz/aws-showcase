import type { Page, PageRequest } from "../../../shared/page.js";
import type { Event } from "./event.js";
import type { EventImage } from "./event-image.js";

/** Port for event persistence. The DynamoDB adapter implements it; tests use an in-memory fake. */
export interface EventRepository {
  create(event: Event): Promise<void>;
  findById(eventId: string): Promise<Event | undefined>;
  /** Upcoming events ordered by start time. */
  listUpcoming(from: Date, page: PageRequest): Promise<Page<Event>>;
  /**
   * Records an image on the event unless a newer one is already there (S3 events can arrive out of
   * order). Returns the image it replaced so the caller can delete that object.
   */
  attachImage(eventId: string, image: EventImage): Promise<AttachImageResult>;
}

export type AttachImageResult =
  | { readonly status: "attached"; readonly replaced?: EventImage }
  | { readonly status: "stale" }
  | { readonly status: "event_not_found" };
