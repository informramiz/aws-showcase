import type { Context, SQSRecord } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { LogNotifier } from "../../../src/features/notifications/adapters/log-notifier.js";
import {
  parseNotification,
  SendNotification,
} from "../../../src/features/notifications/application/send-notification.js";
import { makeNotificationWorker } from "../../../src/features/notifications/sqs/worker.js";
import { bookingEvent } from "../../../src/features/bookings/domain/booking-events.js";
import { aBooking, LATER, NOW, silentLogger } from "../../support/fixtures.js";

const envelope = (detail: unknown, detailType = "BookingConfirmed") =>
  JSON.stringify({ version: "0", source: "bookings-api", "detail-type": detailType, detail });

const record = (messageId: string, body: string) => ({ messageId, body }) as SQSRecord;

describe("notifications", () => {
  const confirmed = bookingEvent("BookingConfirmed", aBooking(), NOW);

  it("parses the EventBridge envelope from the SQS body", () => {
    expect(parseNotification(envelope(confirmed))).toEqual(confirmed);
    expect(() => parseNotification(envelope({ ...confirmed, seats: 0 }))).toThrow();
    expect(() => parseNotification("not json")).toThrow();
  });

  it("parses waitlist offers and reminders, and rejects a detail that does not match its type", () => {
    const offered = {
      type: "WaitlistSeatOffered",
      eventId: "e1",
      userId: "u1",
      offerExpiresAt: LATER,
      occurredAt: LATER,
    };
    const reminder = {
      type: "EventReminder",
      eventId: "e1",
      userId: "u1",
      eventTitle: "TypeScript Summit",
      eventStartsAt: LATER,
      occurredAt: LATER,
    };
    expect(parseNotification(envelope(offered, "WaitlistSeatOffered"))).toEqual(offered);
    expect(parseNotification(envelope(reminder, "EventReminder"))).toEqual(reminder);
    expect(() => parseNotification(envelope({ ...reminder, eventTitle: undefined }, "EventReminder"))).toThrow();
    expect(() => parseNotification(envelope(offered, "SomethingElse"))).toThrow();
  });

  it("logs which template it would send", async () => {
    const logger = silentLogger();
    const info = vi.spyOn(logger, "info");
    const notifier = new LogNotifier(logger);

    await notifier.notify(confirmed);
    await notifier.notify({ ...confirmed, type: "BookingCancelled" });
    await notifier.notify({
      type: "WaitlistSeatOffered",
      eventId: "e1",
      userId: "u1",
      offerExpiresAt: LATER,
      occurredAt: LATER,
    });
    await notifier.notify({
      type: "EventReminder",
      eventId: "e1",
      userId: "u1",
      eventTitle: "T",
      eventStartsAt: LATER,
      occurredAt: LATER,
    });

    expect(info).toHaveBeenNthCalledWith(
      1,
      "Notification sent",
      expect.objectContaining({ template: "booking-confirmed" }),
    );
    expect(info).toHaveBeenNthCalledWith(
      2,
      "Notification sent",
      expect.objectContaining({ template: "booking-cancelled" }),
    );
    expect(info).toHaveBeenNthCalledWith(
      3,
      "Notification sent",
      expect.objectContaining({ template: "waitlist-seat-offered" }),
    );
    expect(info).toHaveBeenNthCalledWith(
      4,
      "Notification sent",
      expect.objectContaining({ template: "event-reminder" }),
    );
  });

  it("reports only the failed messages back to SQS", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const worker = makeNotificationWorker(new SendNotification({ notify }));
    const event = {
      Records: [record("ok-1", envelope(confirmed)), record("bad-1", "{}"), record("ok-2", envelope(confirmed))],
    };

    const result = await worker(event, {} as Context);

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "bad-1" }] });
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
