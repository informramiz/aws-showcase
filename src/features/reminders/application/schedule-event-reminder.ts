import type { Clock } from "../../../shared/clock.js";
import type { Telemetry } from "../../../shared/telemetry.js";
import { type ReminderScheduler, reminderTime } from "../domain/reminder.js";

export type ScheduleOutcome = "scheduled" | "exists" | "too-late";

/** A new event was created: schedule its one-time reminder 24 hours before it starts. */
export class ScheduleEventReminder {
  constructor(
    private readonly scheduler: ReminderScheduler,
    private readonly telemetry: Telemetry,
    private readonly clock: Clock,
  ) {}

  async execute(eventId: string, startsAt: string): Promise<ScheduleOutcome> {
    const at = reminderTime(startsAt, this.clock.now());
    if (at === undefined) return "too-late";
    const outcome = await this.scheduler.schedule(eventId, at);
    if (outcome === "scheduled") this.telemetry.count("ReminderScheduled");
    return outcome;
  }
}
