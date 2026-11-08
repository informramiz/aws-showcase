import { beforeEach, describe, expect, it } from "vitest";
import { BookSeats } from "../../../src/features/bookings/application/book-seats.js";
import { CancelBooking } from "../../../src/features/bookings/application/cancel-booking.js";
import { ListMyBookings } from "../../../src/features/bookings/application/list-my-bookings.js";
import { InMemoryBookingRepository, InMemoryEventRepository, RecordingPublisher } from "../../support/fakes.js";
import {
  anEvent,
  attendee,
  fixedClock,
  NOW,
  organizer,
  recordingTelemetry,
  type RecordingTelemetry,
  sequentialIds,
} from "../../support/fixtures.js";

describe("booking use cases", () => {
  let events: InMemoryEventRepository;
  let bookings: InMemoryBookingRepository;
  let publisher: RecordingPublisher;
  let telemetry: RecordingTelemetry;
  let bookSeats: BookSeats;
  const event = anEvent({ capacity: 3, seatsRemaining: 3 });

  beforeEach(async () => {
    events = new InMemoryEventRepository();
    bookings = new InMemoryBookingRepository(events);
    publisher = new RecordingPublisher();
    telemetry = recordingTelemetry();
    bookSeats = new BookSeats(events, bookings, publisher, telemetry, fixedClock(), sequentialIds());
    await events.create(event);
  });

  describe("BookSeats", () => {
    it("takes the seats, counts them and publishes BookingConfirmed", async () => {
      const booking = await bookSeats.execute(attendee(), { eventId: event.id, seats: 2 });

      expect((await events.findById(event.id))?.seatsRemaining).toBe(1);
      expect(telemetry.counts.get("BookingConfirmed")).toBe(1);
      expect(telemetry.counts.get("SeatsBooked")).toBe(2);
      expect(publisher.published).toEqual([
        expect.objectContaining({ type: "BookingConfirmed", bookingId: booking.id, seats: 2 }),
      ]);
    });

    it("only lets attendees book", async () => {
      await expect(bookSeats.execute(organizer(), { eventId: event.id, seats: 1 })).rejects.toMatchObject({
        code: "ATTENDEE_ONLY",
      });
    });

    it("rejects an unknown event", async () => {
      await expect(bookSeats.execute(attendee(), { eventId: "missing", seats: 1 })).rejects.toMatchObject({
        code: "EVENT_NOT_FOUND",
      });
    });

    it("counts a sold-out rejection from the repository", async () => {
      await bookSeats.execute(attendee("a"), { eventId: event.id, seats: 3 });
      // The domain fast path reads a stale snapshot here, so the repository is what says no.
      const stale = new BookSeats(
        {
          findById: () => Promise.resolve(event),
          create: () => Promise.resolve(),
          listUpcoming: () => Promise.resolve({ items: [] }),
        },
        bookings,
        publisher,
        telemetry,
        fixedClock(),
        sequentialIds("b"),
      );
      await expect(stale.execute(attendee("b"), { eventId: event.id, seats: 1 })).rejects.toMatchObject({
        code: "SOLD_OUT",
      });
      expect(telemetry.counts.get("BookingRejectedSoldOut")).toBe(1);
    });

    it("rejects a second booking by the same user without counting it as sold out", async () => {
      await bookSeats.execute(attendee(), { eventId: event.id, seats: 1 });
      await expect(bookSeats.execute(attendee(), { eventId: event.id, seats: 1 })).rejects.toMatchObject({
        code: "ALREADY_BOOKED",
      });
      expect(telemetry.counts.has("BookingRejectedSoldOut")).toBe(false);
    });

    it("keeps a committed booking when publishing fails, and records the failure", async () => {
      publisher.failWith = new Error("EventBridge down");
      const booking = await bookSeats.execute(attendee(), { eventId: event.id, seats: 1 });

      expect(bookings.bookings.get(booking.id)?.status).toBe("CONFIRMED");
      expect(telemetry.counts.get("EventPublishFailed")).toBe(1);
      expect(telemetry.errors).toHaveLength(1);
    });
  });

  describe("CancelBooking", () => {
    it("cancels, returns the seats and publishes BookingCancelled", async () => {
      const booking = await bookSeats.execute(attendee(), { eventId: event.id, seats: 2 });
      const cancel = new CancelBooking(bookings, publisher, telemetry, fixedClock());

      const cancelled = await cancel.execute(attendee(), event.id, booking.id);

      expect(cancelled).toMatchObject({ status: "CANCELLED", cancelledAt: NOW.toISOString() });
      expect((await events.findById(event.id))?.seatsRemaining).toBe(3);
      expect(telemetry.counts.get("BookingCancelled")).toBe(1);
      expect(publisher.published.at(-1)?.type).toBe("BookingCancelled");
    });

    it("rejects an unknown booking", async () => {
      const cancel = new CancelBooking(bookings, publisher, telemetry, fixedClock());
      await expect(cancel.execute(attendee(), event.id, "missing")).rejects.toMatchObject({
        code: "BOOKING_NOT_FOUND",
      });
    });
  });

  describe("ListMyBookings", () => {
    it("returns only the caller's bookings", async () => {
      await bookSeats.execute(attendee("a"), { eventId: event.id, seats: 1 });
      await bookSeats.execute(attendee("b"), { eventId: event.id, seats: 1 });

      const page = await new ListMyBookings(bookings).execute(attendee("a"), { limit: 10 });

      expect(page.items.map((b) => b.userId)).toEqual(["a"]);
    });
  });
});
