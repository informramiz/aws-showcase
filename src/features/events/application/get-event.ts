import { NotFoundError } from "../../../shared/errors.js";
import type { Event } from "../domain/event.js";
import type { EventRepository } from "../domain/event-repository.js";

export class GetEvent {
  constructor(private readonly events: EventRepository) {}

  async execute(eventId: string): Promise<Event> {
    const event = await this.events.findById(eventId);
    if (event === undefined) throw new NotFoundError("EVENT_NOT_FOUND", "Event not found");
    return event;
  }
}
