import type { Logger } from "@aws-lambda-powertools/logger";
import type { BookingEvent } from "../../bookings/domain/booking-events.js";
import type { Notifier } from "../domain/notifier.js";

/**
 * Stub notifier: logs what would be sent. A real one would look up the user's email via Cognito and
 * send through SES; the port means only this file changes.
 */
export class LogNotifier implements Notifier {
  constructor(private readonly logger: Logger) {}

  notify(event: BookingEvent): Promise<void> {
    this.logger.info("Notification sent", {
      template: event.type === "BookingConfirmed" ? "booking-confirmed" : "booking-cancelled",
      bookingId: event.bookingId,
      eventId: event.eventId,
      userId: event.userId,
    });
    return Promise.resolve();
  }
}
