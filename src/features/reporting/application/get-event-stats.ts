import type { Actor } from "../../../shared/actor.js";
import { NotFoundError } from "../../../shared/errors.js";
import { assertManagedBy } from "../../events/domain/event.js";
import type { EventRepository } from "../../events/domain/event-repository.js";
import { emptyStats, type EventStats } from "../domain/event-stats.js";
import type { StatsRepository } from "../domain/stats-repository.js";

/** Stats are the organizer's business data: only the event's own organizer may read them. */
export class GetEventStats {
  constructor(
    private readonly events: EventRepository,
    private readonly stats: StatsRepository,
  ) {}

  async execute(actor: Actor, eventId: string): Promise<EventStats> {
    const event = await this.events.findById(eventId);
    if (event === undefined) throw new NotFoundError("EVENT_NOT_FOUND", "Event not found");
    assertManagedBy(event, actor);
    return (await this.stats.get(eventId)) ?? emptyStats(eventId);
  }
}
