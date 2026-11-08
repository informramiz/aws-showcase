import type { Telemetry } from "../../../shared/telemetry.js";
import type { BookingEvent, BookingEventPublisher } from "../domain/booking-events.js";

/**
 * Publishes after the database commit. A failed publish must not fail a booking that already
 * committed, so it is logged and counted (alarm on `EventPublishFailed`). See README "Trade-offs" for
 * the outbox alternative that removes this gap.
 */
export const publishSafely = async (
  publisher: BookingEventPublisher,
  telemetry: Telemetry,
  event: BookingEvent,
): Promise<void> => {
  try {
    await publisher.publish(event);
  } catch (error) {
    telemetry.count("EventPublishFailed");
    telemetry.error("Failed to publish booking event", error, { type: event.type, bookingId: event.bookingId });
  }
};
