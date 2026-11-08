import type { BookingEvent } from "../../bookings/domain/booking-events.js";
import type { EventReminder } from "../../reminders/domain/reminder.js";
import type { WaitlistSeatOffered } from "../../waitlist/domain/waitlist.js";

/** Every integration event that results in a message to a user. */
export type Notification = BookingEvent | WaitlistSeatOffered | EventReminder;

/** Event types routed from the bus to the notification queue. */
export const NOTIFICATION_TYPES = [
  "BookingConfirmed",
  "BookingCancelled",
  "WaitlistSeatOffered",
  "EventReminder",
] as const satisfies readonly Notification["type"][];

/** Port for sending a notification (email, push, ...). */
export interface Notifier {
  notify(notification: Notification): Promise<void>;
}
