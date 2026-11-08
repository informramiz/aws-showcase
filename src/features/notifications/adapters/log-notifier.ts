import type { Logger } from "@aws-lambda-powertools/logger";
import type { Notification, Notifier } from "../domain/notifier.js";

const TEMPLATES = {
  BookingConfirmed: "booking-confirmed",
  BookingCancelled: "booking-cancelled",
  WaitlistSeatOffered: "waitlist-seat-offered",
  EventReminder: "event-reminder",
} as const satisfies Record<Notification["type"], string>;

/**
 * Stub notifier: logs what would be sent. A real one would look up the user's email via Cognito and
 * send through SES; the port means only this file changes.
 */
export class LogNotifier implements Notifier {
  constructor(private readonly logger: Logger) {}

  notify(notification: Notification): Promise<void> {
    this.logger.info("Notification sent", {
      template: TEMPLATES[notification.type],
      eventId: notification.eventId,
      userId: notification.userId,
      ...("bookingId" in notification ? { bookingId: notification.bookingId } : {}),
    });
    return Promise.resolve();
  }
}
