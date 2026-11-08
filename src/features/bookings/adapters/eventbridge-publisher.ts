import { type EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { BOOKING_EVENT_SOURCE, type BookingEvent, type BookingEventPublisher } from "../domain/booking-events.js";

/** Publishes booking events to a custom EventBridge bus. `detail-type` is the event type, for rule matching. */
export class EventBridgeBookingPublisher implements BookingEventPublisher {
  constructor(
    private readonly client: EventBridgeClient,
    private readonly busName: string,
  ) {}

  async publish(event: BookingEvent): Promise<void> {
    const result = await this.client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.busName,
            Source: BOOKING_EVENT_SOURCE,
            DetailType: event.type,
            Detail: JSON.stringify(event),
          },
        ],
      }),
    );
    // PutEvents reports per-entry failures in the response body instead of throwing.
    if ((result.FailedEntryCount ?? 0) > 0) {
      const entry = result.Entries?.[0];
      throw new Error(`EventBridge rejected the event: ${entry?.ErrorCode ?? "unknown"} ${entry?.ErrorMessage ?? ""}`);
    }
  }
}
