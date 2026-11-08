import type { Page, PageRequest } from "../../../shared/page.js";
import type { Event } from "./event.js";

/** Port for event persistence. The DynamoDB adapter implements it; tests use an in-memory fake. */
export interface EventRepository {
  create(event: Event): Promise<void>;
  findById(eventId: string): Promise<Event | undefined>;
  /** Upcoming events ordered by start time. */
  listUpcoming(from: Date, page: PageRequest): Promise<Page<Event>>;
}
