import { DynamoDBPersistenceLayer } from "@aws-lambda-powertools/idempotency/dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoDbBookingRepository } from "../../src/features/bookings/adapters/dynamodb-booking-repository.js";
import { makeIdempotentBookSeats } from "../../src/features/bookings/adapters/idempotent-book-seats.js";
import { BookSeats } from "../../src/features/bookings/application/book-seats.js";
import { DynamoDbEventRepository } from "../../src/features/events/adapters/dynamodb-event-repository.js";
import { uuidGenerator } from "../../src/shared/ids.js";
import { RecordingPublisher } from "../support/fakes.js";
import { anEvent, attendee, fixedClock, recordingTelemetry } from "../support/fixtures.js";
import { createAppTable, createIdempotencyTable, localClients } from "./dynamo.js";

describe("idempotent booking with the real Powertools DynamoDB layer (DynamoDB Local)", () => {
  it("books once per key, replays the stored booking, and rejects a changed body", async () => {
    const { client, doc } = localClients();
    const tableName = await createAppTable(client);
    const events = new DynamoDbEventRepository(doc, tableName);
    const bookings = new DynamoDbBookingRepository(doc, tableName);
    const event = anEvent({ capacity: 10, seatsRemaining: 10 });
    await events.create(event);
    const publisher = new RecordingPublisher();
    const bookSeats = new BookSeats(events, bookings, publisher, recordingTelemetry(), fixedClock(), uuidGenerator);
    const store = new DynamoDBPersistenceLayer({
      tableName: await createIdempotencyTable(client),
      awsSdkV3Client: client,
    });
    const once = makeIdempotentBookSeats(bookSeats, store);
    const command = { eventId: event.id, seats: 2 };

    const first = await once(attendee("u1"), "key-00000001", command);
    const retry = await once(attendee("u1"), "key-00000001", command);

    expect(retry).toEqual(first);
    expect((await events.findById(event.id))?.seatsRemaining).toBe(8);
    expect(publisher.published).toHaveLength(1);
    await expect(once(attendee("u1"), "key-00000001", { ...command, seats: 3 })).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });
});
