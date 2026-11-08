import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it } from "vitest";
import { DynamoDbBookingRepository } from "../../src/features/bookings/adapters/dynamodb-booking-repository.js";
import { DynamoDbEventRepository } from "../../src/features/events/adapters/dynamodb-event-repository.js";
import { cancelBooking } from "../../src/features/bookings/domain/booking.js";
import { Keys } from "../../src/shared/dynamodb/keys.js";
import { aBooking, anEvent, NOW } from "../support/fixtures.js";
import { createAppTable, localClients } from "./dynamo.js";

describe("DynamoDbBookingRepository (DynamoDB Local)", () => {
  const { client, doc } = localClients();
  const event = anEvent({ capacity: 3, seatsRemaining: 3 });
  let tableName: string;
  let events: DynamoDbEventRepository;
  let bookings: DynamoDbBookingRepository;

  beforeEach(async () => {
    tableName = await createAppTable(client);
    events = new DynamoDbEventRepository(doc, tableName);
    bookings = new DynamoDbBookingRepository(doc, tableName);
    await events.create(event);
  });

  const seatsLeft = async () => (await events.findById(event.id))?.seatsRemaining;

  it("confirm takes the seats and stores the booking and attendee marker in one transaction", async () => {
    const booking = aBooking({ seats: 2 });
    await bookings.confirm(booking);

    expect(await seatsLeft()).toBe(1);
    expect(await bookings.findById(event.id, booking.id)).toEqual(booking);
    const marker = await doc.send(new GetCommand({ TableName: tableName, Key: Keys.attendee(event.id, "user-1") }));
    expect(marker.Item?.["bookingId"]).toBe(booking.id);
  });

  it("maps each failed condition to its domain error and leaves nothing half-written", async () => {
    await bookings.confirm(aBooking({ id: "b1", seats: 1 }));

    await expect(bookings.confirm(aBooking({ id: "b2", seats: 1 }))).rejects.toMatchObject({ code: "ALREADY_BOOKED" });
    await expect(bookings.confirm(aBooking({ id: "b3", userId: "u2", seats: 3 }))).rejects.toMatchObject({
      code: "SOLD_OUT",
    });
    await expect(bookings.confirm(aBooking({ id: "b4", eventId: "gone", seats: 1 }))).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
    });

    expect(await seatsLeft()).toBe(2);
    expect(await bookings.findById(event.id, "b2")).toBeUndefined();
    expect(await bookings.findById(event.id, "b3")).toBeUndefined();
  });

  it("cancel returns the seats, frees the user to book again, and cannot run twice", async () => {
    const booking = aBooking({ seats: 2 });
    await bookings.confirm(booking);
    const cancelled = cancelBooking(booking, booking.userId, NOW);

    await bookings.cancel(cancelled);
    await expect(bookings.cancel(cancelled)).rejects.toMatchObject({ code: "ALREADY_CANCELLED" });

    expect(await seatsLeft()).toBe(3);
    expect(await bookings.findById(event.id, booking.id)).toEqual(cancelled);
    await bookings.confirm(aBooking({ id: "b-again", seats: 1 }));
    expect(await seatsLeft()).toBe(2);
  });

  it("lists a user's bookings newest first across pages", async () => {
    const second = anEvent({ id: "e2" });
    await events.create(second);
    await bookings.confirm(aBooking({ id: "old", createdAt: "2030-01-01T00:00:00.000Z", seats: 1 }));
    await bookings.confirm(aBooking({ id: "new", eventId: "e2", createdAt: "2030-01-02T00:00:00.000Z", seats: 1 }));
    await bookings.confirm(aBooking({ id: "other", userId: "someone-else", seats: 1 }));

    const first = await bookings.listByUser("user-1", { limit: 1 });
    const rest = await bookings.listByUser("user-1", { limit: 1, cursor: first.nextCursor });

    expect(first.items.map((b) => b.id)).toEqual(["new"]);
    expect(rest.items.map((b) => b.id)).toEqual(["old"]);
  });
});
