import type { Clock } from "../../../shared/clock.js";
import type { Telemetry } from "../../../shared/telemetry.js";
import { hasStarted } from "../../events/domain/event.js";
import type { EventRepository } from "../../events/domain/event-repository.js";
import type { AttendeeDirectory, EventReminder, ReminderPublisher } from "../domain/reminder.js";

/**
 * Scheduler target: publish one `EventReminder` per attendee. Throws if publishing fails so EventBridge
 * Scheduler retries (and then dead-letters); a retry may remind someone twice, which is acceptable.
 */
export class SendEventReminders {
  constructor(
    private readonly events: EventRepository,
    private readonly attendees: AttendeeDirectory,
    private readonly publisher: ReminderPublisher,
    private readonly telemetry: Telemetry,
    private readonly clock: Clock,
  ) {}

  /** Returns how many reminders were sent. */
  async execute(eventId: string): Promise<number> {
    const now = this.clock.now();
    const event = await this.events.findById(eventId);
    if (event === undefined || hasStarted(event, now)) return 0;

    const userIds = await this.attendees.listAttendees(eventId);
    const reminders = userIds.map((userId): EventReminder => ({
      type: "EventReminder",
      eventId,
      userId,
      eventTitle: event.title,
      eventStartsAt: event.startsAt,
      occurredAt: now.toISOString(),
    }));
    await this.publisher.publishAll(reminders);
    this.telemetry.count("RemindersSent", reminders.length);
    return reminders.length;
  }
}
