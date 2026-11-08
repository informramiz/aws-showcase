import { type EventBridgeClient, PutEventsCommand, type PutEventsResultEntry } from "@aws-sdk/client-eventbridge";
import {
  type BatchEventPublisher,
  EVENT_SOURCE,
  type EventPublisher,
  type IntegrationEvent,
} from "./integration-event.js";

/** PutEvents accepts at most 10 entries per call. */
export const PUT_EVENTS_MAX_ENTRIES = 10;

/**
 * Publishes integration events to a custom EventBridge bus. `detail-type` is the event type, for rule
 * matching. PutEvents reports per-entry failures in the response body instead of throwing, so any
 * failed entry is turned into an error here.
 * https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEvents.html
 */
export class EventBridgePublisher<E extends IntegrationEvent> implements EventPublisher<E>, BatchEventPublisher<E> {
  constructor(
    private readonly client: EventBridgeClient,
    private readonly busName: string,
  ) {}

  publish(event: E): Promise<void> {
    return this.publishAll([event]);
  }

  async publishAll(events: readonly E[]): Promise<void> {
    for (let i = 0; i < events.length; i += PUT_EVENTS_MAX_ENTRIES) {
      const chunk = events.slice(i, i + PUT_EVENTS_MAX_ENTRIES);
      const result = await this.client.send(
        new PutEventsCommand({
          Entries: chunk.map((event) => ({
            EventBusName: this.busName,
            Source: EVENT_SOURCE,
            DetailType: event.type,
            Detail: JSON.stringify(event),
          })),
        }),
      );
      if ((result.FailedEntryCount ?? 0) > 0) {
        const failed: PutEventsResultEntry | undefined = result.Entries?.find((e) => e.ErrorCode !== undefined);
        throw new Error(
          `EventBridge rejected ${String(result.FailedEntryCount)} event(s): ${failed?.ErrorCode ?? "unknown"} ${failed?.ErrorMessage ?? ""}`,
        );
      }
    }
  }
}
