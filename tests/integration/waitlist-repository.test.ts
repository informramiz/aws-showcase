import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it } from "vitest";
import { DynamoDbBookingRepository } from "../../src/features/bookings/adapters/dynamodb-booking-repository.js";
import { DynamoDbEventRepository } from "../../src/features/events/adapters/dynamodb-event-repository.js";
import { DynamoDbAttendeeDirectory } from "../../src/features/reminders/adapters/dynamodb-attendee-directory.js";
import { DynamoDbWaitlistRepository } from "../../src/features/waitlist/adapters/dynamodb-waitlist-repository.js";
import { joinWaitlist } from "../../src/features/waitlist/domain/waitlist.js";
import { Keys } from "../../src/shared/dynamodb/keys.js";
import { aBooking, anEvent, NOW } from "../support/fixtures.js";
import { createAppTable, localClients } from "./dynamo.js";

const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const HOLD_UNTIL = later(900);

describe("DynamoDbWaitlistRepository (DynamoDB Local)", () => {
  const { client, doc } = localClients();
  const event = anEvent({ capacity: 1, seatsRemaining: 1 });
  let tableName: string;
  let events: DynamoDbEventRepository;
  let bookings: DynamoDbBookingRepository;
  let waitlist: DynamoDbWaitlistRepository;

  beforeEach(async () => {
    tableName = await createAppTable(client);
    events = new DynamoDbEventRepository(doc, tableName);
    bookings = new DynamoDbBookingRepository(doc, tableName);
    waitlist = new DynamoDbWaitlistRepository(doc, tableName);
    await events.create(event);
  });

  const seatsLeft = async () => (await events.findById(event.id))?.seatsRemaining;
  const sellOut = () => bookings.confirm(aBooking({ id: "b0", userId: "holder", seats: 1 }));
  const join = (userId: string, at = NOW) => waitlist.join(joinWaitlist({ ...event, seatsRemaining: 0 }, userId, at));
  const freeSeat = () =>
    bookings.cancel(
      aBooking({ id: "b0", userId: "holder", seats: 1, status: "CANCELLED", cancelledAt: NOW.toISOString() }),
    );

  it("joins only a sold-out event, once, and never while holding a booking", async () => {
    await expect(join("u1")).rejects.toMatchObject({ code: "SEATS_AVAILABLE" });
    await sellOut();

    await join("u1");
    expect(await waitlist.find(event.id, "u1")).toMatchObject({ status: "WAITING", joinedAt: NOW.toISOString() });
    await expect(join("u1")).rejects.toMatchObject({ code: "ALREADY_WAITLISTED" });
    await expect(join("holder")).rejects.toMatchObject({ code: "ALREADY_BOOKED" });
    await expect(
      waitlist.join(joinWaitlist({ ...event, id: "missing", seatsRemaining: 0 }, "u1", NOW)),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("offers the freed seat to the head of the queue and drops them from the sparse index", async () => {
    await sellOut();
    await join("u2", later(1));
    await join("u1");
    await freeSeat();

    expect(await waitlist.offerNext(event.id, NOW, HOLD_UNTIL)).toEqual({
      offered: true,
      userId: "u1",
      offerExpiresAt: HOLD_UNTIL.toISOString(),
    });
    expect(await seatsLeft()).toBe(0);
    const stored = await doc.send(new GetCommand({ TableName: tableName, Key: Keys.waitlistEntry(event.id, "u1") }));
    expect(stored.Item).toMatchObject({ status: "OFFERED", type: "WaitlistEntry" });
    expect(stored.Item?.["GSI1PK"]).toBeUndefined();

    // No seat left for u2 until the offer resolves.
    expect(await waitlist.offerNext(event.id, NOW, HOLD_UNTIL)).toEqual({ offered: false });
  });

  it("offers nothing when the queue is empty or the event has started", async () => {
    await sellOut();
    await join("u1");
    await freeSeat();
    expect(await waitlist.offerNext(event.id, new Date(event.startsAt), HOLD_UNTIL)).toEqual({ offered: false });
    expect(await seatsLeft()).toBe(1);

    await waitlist.offerNext(event.id, NOW, HOLD_UNTIL);
    await waitlist.resolve(event.id, "u1", HOLD_UNTIL);
    expect(await waitlist.offerNext(event.id, NOW, HOLD_UNTIL)).toEqual({ offered: false });
  });

  it("accepts an open offer as a booking with an attendee marker, in one transaction", async () => {
    await sellOut();
    await join("u1");
    await freeSeat();
    await waitlist.offerNext(event.id, NOW, HOLD_UNTIL);
    const booking = aBooking({ id: "b1", userId: "u1", seats: 1 });

    await waitlist.accept(event.id, "u1", booking, later(10));

    expect(await bookings.findById(event.id, "b1")).toEqual(booking);
    expect(await waitlist.find(event.id, "u1")).toMatchObject({ status: "ACCEPTED" });
    expect(await seatsLeft()).toBe(0);
    expect(await waitlist.resolve(event.id, "u1", HOLD_UNTIL)).toBe("accepted");
    expect(await seatsLeft()).toBe(0);
    await expect(waitlist.accept(event.id, "u1", booking, later(20))).rejects.toMatchObject({ code: "NO_OFFER" });
  });

  it("rejects an expired offer, then expires it and puts the seat back exactly once", async () => {
    await sellOut();
    await join("u1");
    await freeSeat();
    await waitlist.offerNext(event.id, NOW, HOLD_UNTIL);

    await expect(
      waitlist.accept(event.id, "u1", aBooking({ id: "b1", userId: "u1", seats: 1 }), HOLD_UNTIL),
    ).rejects.toMatchObject({ code: "OFFER_EXPIRED" });
    expect(await waitlist.resolve(event.id, "u1", HOLD_UNTIL)).toBe("expired");
    expect(await waitlist.resolve(event.id, "u1", HOLD_UNTIL)).toBe("expired");
    expect(await seatsLeft()).toBe(1);
    expect(await bookings.findById(event.id, "b1")).toBeUndefined();

    // An expired user may queue again once the event is full.
    await bookings.confirm(aBooking({ id: "b2", userId: "u3", seats: 1 }));
    await join("u1", later(2000));
    expect(await waitlist.find(event.id, "u1")).toMatchObject({ status: "WAITING" });
  });

  it("lists every attendee of an event across pages", async () => {
    const big = anEvent({ id: "33333333-3333-4333-8333-333333333333", capacity: 500, seatsRemaining: 500 });
    await events.create(big);
    for (let i = 0; i < 30; i++) {
      await bookings.confirm(
        aBooking({ id: `b-${i}`, eventId: big.id, userId: `user-${String(i).padStart(2, "0")}`, seats: 1 }),
      );
    }
    const directory = new DynamoDbAttendeeDirectory(doc, tableName);

    const attendees = await directory.listAttendees(big.id);

    expect(attendees).toHaveLength(30);
    expect(attendees).toContain("user-07");
    expect(await directory.listAttendees("44444444-4444-4444-8444-444444444444")).toEqual([]);
  });
});
