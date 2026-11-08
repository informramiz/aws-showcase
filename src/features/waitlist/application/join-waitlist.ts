import { type Actor, hasRole, Role } from "../../../shared/actor.js";
import type { Clock } from "../../../shared/clock.js";
import { ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import type { Telemetry } from "../../../shared/telemetry.js";
import type { EventRepository } from "../../events/domain/event-repository.js";
import { joinWaitlist, type WaitlistEntry } from "../domain/waitlist.js";
import type { WaitlistRepository } from "../domain/waitlist-repository.js";

export class JoinWaitlist {
  constructor(
    private readonly events: EventRepository,
    private readonly waitlist: WaitlistRepository,
    private readonly telemetry: Telemetry,
    private readonly clock: Clock,
  ) {}

  async execute(actor: Actor, eventId: string): Promise<WaitlistEntry> {
    if (!hasRole(actor, Role.Attendee)) throw new ForbiddenError("ATTENDEE_ONLY", "Only attendees can join a waitlist");
    const event = await this.events.findById(eventId);
    if (event === undefined) throw new NotFoundError("EVENT_NOT_FOUND", "Event not found");

    const entry = joinWaitlist(event, actor.userId, this.clock.now());
    await this.waitlist.join(entry);
    this.telemetry.count("WaitlistJoined");
    return entry;
  }
}
