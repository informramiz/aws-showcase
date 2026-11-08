import { describe, expect, it } from "vitest";
import { DynamoDbBookingRepository } from "../../src/features/bookings/adapters/dynamodb-booking-repository.js";
import { BookSeats } from "../../src/features/bookings/application/book-seats.js";
import { DynamoDbEventRepository } from "../../src/features/events/adapters/dynamodb-event-repository.js";
import { uuidGenerator } from "../../src/shared/ids.js";
import { AppError } from "../../src/shared/errors.js";
import { RecordingPublisher } from "../support/fakes.js";
import { anEvent, attendee, fixedClock, recordingTelemetry } from "../support/fixtures.js";
import { createAppTable, localClients } from "./dynamo.js";

describe("no oversell under concurrency (DynamoDB Local)", () => {
  it("never confirms more seats than the event has, with many users racing for the last seats", async () => {
    const { client, doc } = localClients();
    const tableName = await createAppTable(client);
    const events = new DynamoDbEventRepository(doc, tableName);
    const bookings = new DynamoDbBookingRepository(doc, tableName, { maxAttempts: 8, baseDelayMs: 20 });
    const capacity = 5;
    const event = anEvent({ capacity, seatsRemaining: capacity });
    await events.create(event);
    const bookSeats = new BookSeats(
      events,
      bookings,
      new RecordingPublisher(),
      recordingTelemetry(),
      fixedClock(),
      uuidGenerator,
    );

    // 30 users, each wanting 1 seat, all at once. Every one reads seatsRemaining = 5 before any write lands.
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) => bookSeats.execute(attendee(`user-${i}`), { eventId: event.id, seats: 1 })),
    );

    const confirmed = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const remaining = (await events.findById(event.id))?.seatsRemaining;
    const stored = await Promise.all(confirmed.map(async (r) => bookings.findById(event.id, r.value.id)));

    // The invariant: seats taken always equals bookings confirmed, and never exceeds capacity.
    expect(confirmed.length).toBeLessThanOrEqual(capacity);
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(confirmed.length).toBe(capacity - (remaining ?? Number.NaN));
    // With retries on conflict, demand (30) beats supply (5), so every seat should sell.
    expect(remaining).toBe(0);
    expect(stored.every((b) => b?.status === "CONFIRMED")).toBe(true);
    // Every loser gets a typed, client-facing error, never a 500.
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(AppError);
      expect(["SOLD_OUT", "CONCURRENT_UPDATE"]).toContain((r.reason as AppError).code);
    }
  });
});
