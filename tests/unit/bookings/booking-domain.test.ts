import { describe, expect, it } from "vitest";
import { cancelBooking, MAX_SEATS_PER_BOOKING, requestBooking } from "../../../src/features/bookings/domain/booking.js";
import { bookingEvent } from "../../../src/features/bookings/domain/booking-events.js";
import { aBooking, anEvent, LATER, NOW } from "../../support/fixtures.js";

describe("requestBooking", () => {
  const request = (seats: number, event = anEvent(), now = NOW) =>
    requestBooking({ id: "b1", event, userId: "u1", seats, now });

  it("creates a confirmed booking with the event details denormalised", () => {
    expect(request(2)).toEqual({
      id: "b1",
      eventId: anEvent().id,
      userId: "u1",
      seats: 2,
      status: "CONFIRMED",
      createdAt: NOW.toISOString(),
      eventTitle: "TypeScript Summit",
      eventStartsAt: LATER,
    });
  });

  it.each([0, -1, 1.5, MAX_SEATS_PER_BOOKING + 1])("rejects %d seats", (seats) => {
    expect(() => request(seats)).toThrow(expect.objectContaining({ code: "TOO_MANY_SEATS" }));
  });

  it("rejects an event that has started", () => {
    expect(() => request(1, anEvent(), new Date(LATER))).toThrow(expect.objectContaining({ code: "EVENT_STARTED" }));
  });

  it("rejects more seats than remain", () => {
    expect(() => request(3, anEvent({ seatsRemaining: 2 }))).toThrow(expect.objectContaining({ code: "SOLD_OUT" }));
  });
});

describe("cancelBooking", () => {
  it("cancels the owner's booking", () => {
    expect(cancelBooking(aBooking(), "user-1", NOW)).toMatchObject({
      status: "CANCELLED",
      cancelledAt: NOW.toISOString(),
    });
  });

  it("hides other users' bookings as not found", () => {
    expect(() => cancelBooking(aBooking(), "intruder", NOW)).toThrow(
      expect.objectContaining({ code: "BOOKING_NOT_FOUND" }),
    );
  });

  it("rejects a second cancel and a cancel after the start", () => {
    expect(() => cancelBooking(aBooking({ status: "CANCELLED" }), "user-1", NOW)).toThrow(
      expect.objectContaining({ code: "ALREADY_CANCELLED" }),
    );
    expect(() => cancelBooking(aBooking(), "user-1", new Date(LATER))).toThrow(
      expect.objectContaining({ code: "EVENT_STARTED" }),
    );
  });
});

describe("bookingEvent", () => {
  it("carries ids and facts only", () => {
    expect(bookingEvent("BookingConfirmed", aBooking(), NOW)).toEqual({
      type: "BookingConfirmed",
      bookingId: aBooking().id,
      eventId: aBooking().eventId,
      userId: "user-1",
      seats: 2,
      occurredAt: NOW.toISOString(),
    });
  });
});
