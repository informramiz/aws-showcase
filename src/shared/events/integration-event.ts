/** EventBridge `source` for every event this service publishes. */
export const EVENT_SOURCE = "bookings-api";

/**
 * An integration event: a fact other services (and our own notifier) react to, published after the
 * change commits. `type` becomes the EventBridge `detail-type`, so rules can match on it. Events
 * carry IDs and facts, never PII.
 */
export interface IntegrationEvent {
  readonly type: string;
  readonly occurredAt: string;
}

/** Port for publishing one event. */
export interface EventPublisher<E extends IntegrationEvent> {
  publish(event: E): Promise<void>;
}

/** Port for publishing many events at once (fan-out). */
export interface BatchEventPublisher<E extends IntegrationEvent> {
  publishAll(events: readonly E[]): Promise<void>;
}
