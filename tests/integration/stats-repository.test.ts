import { describe, expect, it } from "vitest";
import { DynamoDbStatsRepository } from "../../src/features/reporting/adapters/dynamodb-stats-repository.js";
import { fixedClock } from "../support/fixtures.js";
import { createAppTable, createIdempotencyTable, localClients } from "./dynamo.js";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

describe("DynamoDbStatsRepository (DynamoDB Local)", () => {
  it("adds deltas exactly once per stream record and reads them back", async () => {
    const { client, doc } = localClients();
    const repo = new DynamoDbStatsRepository(
      doc,
      await createAppTable(client),
      await createIdempotencyTable(client),
      fixedClock(),
    );

    expect(await repo.get(EVENT_ID)).toBeUndefined();
    expect(
      await repo.apply("rec-1", EVENT_ID, { bookingsConfirmed: 1, seatsBooked: 4 }, "2030-01-01T12:00:00.000Z"),
    ).toBe("applied");
    expect(
      await repo.apply("rec-1", EVENT_ID, { bookingsConfirmed: 1, seatsBooked: 4 }, "2030-01-01T12:00:00.000Z"),
    ).toBe("duplicate");
    expect(
      await repo.apply("rec-2", EVENT_ID, { bookingsCancelled: 1, seatsBooked: -4 }, "2030-01-01T12:05:00.000Z"),
    ).toBe("applied");

    expect(await repo.get(EVENT_ID)).toEqual({
      eventId: EVENT_ID,
      bookingsConfirmed: 1,
      bookingsCancelled: 1,
      seatsBooked: 0,
      waitlistJoined: 0,
      waitlistWaiting: 0,
      offersMade: 0,
      offersAccepted: 0,
      offersExpired: 0,
      updatedAt: "2030-01-01T12:05:00.000Z",
    });
  });
});
