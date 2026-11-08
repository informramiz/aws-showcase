import type { Clock } from "../../../shared/clock.js";
import type { Page, PageRequest } from "../../../shared/page.js";
import type { Event } from "../domain/event.js";
import type { EventRepository } from "../domain/event-repository.js";

export class ListEvents {
  constructor(
    private readonly events: EventRepository,
    private readonly clock: Clock,
  ) {}

  execute(page: PageRequest): Promise<Page<Event>> {
    return this.events.listUpcoming(this.clock.now(), page);
  }
}
