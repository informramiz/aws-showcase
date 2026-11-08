import { type Actor, hasRole, Role } from "../../../shared/actor.js";
import type { Clock } from "../../../shared/clock.js";
import { ForbiddenError } from "../../../shared/errors.js";
import type { IdGenerator } from "../../../shared/ids.js";
import { createEvent, type Event } from "../domain/event.js";
import type { EventRepository } from "../domain/event-repository.js";

export interface CreateEventCommand {
  readonly title: string;
  readonly venue: string;
  readonly startsAt: Date;
  readonly capacity: number;
}

export class CreateEvent {
  constructor(
    private readonly events: EventRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(actor: Actor, command: CreateEventCommand): Promise<Event> {
    if (!hasRole(actor, Role.Organizer)) {
      throw new ForbiddenError("ORGANIZER_ONLY", "Only organizers can create events");
    }
    const event = createEvent({ ...command, id: this.ids.next(), organizerId: actor.userId, now: this.clock.now() });
    await this.events.create(event);
    return event;
  }
}
