import type { Context, SQSRecord } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { LogNotifier } from "../../../src/features/notifications/adapters/log-notifier.js";
import {
  parseBookingEvent,
  SendBookingNotification,
} from "../../../src/features/notifications/application/send-booking-notification.js";
import { makeNotificationWorker } from "../../../src/features/notifications/sqs/worker.js";
import { bookingEvent } from "../../../src/features/bookings/domain/booking-events.js";
import { aBooking, NOW, silentLogger } from "../../support/fixtures.js";

const envelope = (detail: unknown, detailType = "BookingConfirmed") =>
  JSON.stringify({ version: "0", source: "bookings-api", "detail-type": detailType, detail });

const record = (messageId: string, body: string) => ({ messageId, body }) as SQSRecord;

describe("notifications", () => {
  const confirmed = bookingEvent("BookingConfirmed", aBooking(), NOW);

  it("parses the EventBridge envelope from the SQS body", () => {
    expect(parseBookingEvent(envelope(confirmed))).toEqual(confirmed);
    expect(() => parseBookingEvent(envelope({ ...confirmed, seats: 0 }))).toThrow();
    expect(() => parseBookingEvent("not json")).toThrow();
  });

  it("logs which template it would send", async () => {
    const logger = silentLogger();
    const info = vi.spyOn(logger, "info");
    const notifier = new LogNotifier(logger);

    await notifier.notify(confirmed);
    await notifier.notify({ ...confirmed, type: "BookingCancelled" });

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
  });

  it("reports only the failed messages back to SQS", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const worker = makeNotificationWorker(new SendBookingNotification({ notify }));
    const event = {
      Records: [record("ok-1", envelope(confirmed)), record("bad-1", "{}"), record("ok-2", envelope(confirmed))],
    };

    const result = await worker(event, {} as Context);

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "bad-1" }] });
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
