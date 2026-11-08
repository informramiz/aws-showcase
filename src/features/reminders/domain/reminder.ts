import type { BatchEventPublisher, IntegrationEvent } from "../../../shared/events/integration-event.js";

/** Attendees are reminded this long before an event starts. */
export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

/** When to remind for an event starting at `startsAt`, or undefined if that moment has passed. */
export const reminderTime = (startsAt: string, now: Date): Date | undefined => {
  const at = Date.parse(startsAt) - REMINDER_LEAD_MS;
  return at > now.getTime() ? new Date(at) : undefined;
};

/** One reminder per attendee, fanned out through the notification queue. */
export interface EventReminder extends IntegrationEvent {
  readonly type: "EventReminder";
  readonly eventId: string;
  readonly userId: string;
  readonly eventTitle: string;
  readonly eventStartsAt: string;
}

export type ReminderPublisher = BatchEventPublisher<EventReminder>;

/** Port for a one-time trigger at a point in time. Creating the same reminder twice is a no-op. */
export interface ReminderScheduler {
  schedule(eventId: string, at: Date): Promise<"scheduled" | "exists">;
}

/** Port for the user ids holding an active booking for an event. */
export interface AttendeeDirectory {
  listAttendees(eventId: string): Promise<string[]>;
}
