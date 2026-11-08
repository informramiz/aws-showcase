import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoDbBookingRepository } from "../../../src/features/bookings/adapters/dynamodb-booking-repository.js";
import { EventBridgePublisher } from "../../../src/shared/events/eventbridge-publisher.js";
import { makeIdempotentBookSeats } from "../../../src/features/bookings/adapters/idempotent-book-seats.js";
import type { BookSeats } from "../../../src/features/bookings/application/book-seats.js";
import { bookingEvent } from "../../../src/features/bookings/domain/booking-events.js";
import { InMemoryIdempotencyStore } from "../../support/in-memory-idempotency-store.js";
import { aBooking, attendee, NOW } from "../../support/fixtures.js";

const cancelled = (...codes: string[]) =>
  new TransactionCanceledException({
    message: "Transaction cancelled",
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

const repoWith = (send: (...args: unknown[]) => Promise<unknown>) =>
  new DynamoDbBookingRepository({ send } as unknown as DynamoDBDocumentClient, "table", {
    maxAttempts: 3,
    baseDelayMs: 0,
  });

describe("DynamoDbBookingRepository transaction handling", () => {
  it("retries a TransactionConflict and succeeds", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(cancelled("None", "TransactionConflict", "None"))
      .mockResolvedValue({});
    await repoWith(send).confirm(aBooking());
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts with a retryable 409", async () => {
    const send = vi.fn().mockRejectedValue(cancelled("TransactionConflict", "None", "None"));
    await expect(repoWith(send).confirm(aBooking())).rejects.toMatchObject({ code: "CONCURRENT_UPDATE" });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not retry a cancellation that is not a conflict", async () => {
    const send = vi.fn().mockRejectedValue(cancelled("None", "None", "ConditionalCheckFailed"));
    await expect(repoWith(send).confirm(aBooking())).rejects.toMatchObject({ code: "CONCURRENT_UPDATE" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("rethrows other errors untouched", async () => {
    const boom = new Error("network");
    await expect(repoWith(vi.fn().mockRejectedValue(boom)).cancel(aBooking())).rejects.toBe(boom);
  });
});

describe("EventBridgePublisher", () => {
  const event = bookingEvent("BookingConfirmed", aBooking(), NOW);

  it("puts the event on the bus with source and detail-type", async () => {
    const send = vi.fn().mockResolvedValue({ FailedEntryCount: 0 });
    await new EventBridgePublisher({ send } as unknown as EventBridgeClient, "bus").publish(event);

    const input = (send.mock.calls[0]?.[0] as { input: { Entries: unknown[] } }).input;
    expect(input.Entries).toEqual([
      { EventBusName: "bus", Source: "bookings-api", DetailType: "BookingConfirmed", Detail: JSON.stringify(event) },
    ]);
  });

  it("throws when EventBridge rejects the entry", async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ FailedEntryCount: 1, Entries: [{ ErrorCode: "Throttled", ErrorMessage: "slow down" }] });
    await expect(
      new EventBridgePublisher({ send } as unknown as EventBridgeClient, "bus").publish(event),
    ).rejects.toThrow("Throttled slow down");
  });

  it("sends at most 10 entries per PutEvents call", async () => {
    const send = vi.fn().mockResolvedValue({ FailedEntryCount: 0 });
    const events = Array.from({ length: 23 }, () => event);
    await new EventBridgePublisher({ send } as unknown as EventBridgeClient, "bus").publishAll(events);

    const sizes = send.mock.calls.map((c) => (c[0] as { input: { Entries: unknown[] } }).input.Entries.length);
    expect(sizes).toEqual([10, 10, 3]);
  });

  it("reports an unknown failure when there are no entry details", async () => {
    const send = vi.fn().mockResolvedValue({ FailedEntryCount: 1 });
    await expect(
      new EventBridgePublisher({ send } as unknown as EventBridgeClient, "bus").publish(event),
    ).rejects.toThrow("unknown");
  });
});

describe("makeIdempotentBookSeats", () => {
  it("maps a retry that arrives while the first call runs to 409 REQUEST_IN_PROGRESS", async () => {
    let finish: (booking: unknown) => void = () => undefined;
    const execute = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const once = makeIdempotentBookSeats({ execute } as unknown as BookSeats, new InMemoryIdempotencyStore());
    const command = { eventId: "e", seats: 1 };

    const first = once(attendee("u"), "key-00000001", command);
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalled();
    });
    await expect(once(attendee("u"), "key-00000001", command)).rejects.toMatchObject({
      code: "REQUEST_IN_PROGRESS",
    });

    finish(aBooking());
    await expect(first).resolves.toEqual(aBooking());
  });

  it("passes other errors through", async () => {
    const boom = new Error("db down");
    const once = makeIdempotentBookSeats(
      { execute: vi.fn().mockRejectedValue(boom) } as unknown as BookSeats,
      new InMemoryIdempotencyStore(),
    );
    await expect(once(attendee("u"), "key-00000001", { eventId: "e", seats: 1 })).rejects.toBe(boom);
  });
});
