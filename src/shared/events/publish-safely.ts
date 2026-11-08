import type { Telemetry } from "../telemetry.js";
import type { EventPublisher, IntegrationEvent } from "./integration-event.js";

/**
 * Publishes after the database commit. A failed publish must not fail a change that already
 * committed, so it is logged and counted (alarm on `EventPublishFailed`). See README "Trade-offs" for
 * the outbox alternative that removes this gap. Events hold only IDs, so logging one is safe.
 */
export const publishSafely = async <E extends IntegrationEvent>(
  publisher: EventPublisher<E>,
  telemetry: Telemetry,
  event: E,
): Promise<void> => {
  try {
    await publisher.publish(event);
  } catch (error) {
    telemetry.count("EventPublishFailed");
    telemetry.error("Failed to publish integration event", error, { event });
  }
};
