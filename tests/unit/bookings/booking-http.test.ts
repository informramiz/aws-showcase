import { beforeEach, describe, expect, it } from "vitest";
import { BookSeats } from "../../../src/features/bookings/application/book-seats.js";
import { CancelBooking } from "../../../src/features/bookings/application/cancel-booking.js";
import { ListMyBookings } from "../../../src/features/bookings/application/list-my-bookings.js";
import {
  type BookSeatsOnce,
  makeIdempotentBookSeats,
} from "../../../src/features/bookings/adapters/idempotent-book-seats.js";
import {
  makeBookSeatsHandler,
  makeCancelBookingHandler,
  makeListMyBookingsHandler,
} from "../../../src/features/bookings/http/handlers.js";
import { InMemoryBookingRepository, InMemoryEventRepository, RecordingPublisher } from "../../support/fakes.js";
import { InMemoryIdempotencyStore } from "../../support/in-memory-idempotency-store.js";
import { anEvent, fixedClock, recordingTelemetry, sequentialIds, silentLogger } from "../../support/fixtures.js";
import { httpEvent, parseBody } from "../../support/http.js";

describe("booking HTTP handlers", () => {
  const logger = silentLogger();
  const event = anEvent({ capacity: 5, seatsRemaining: 5 });
  let events: InMemoryEventRepository;
  let bookings: InMemoryBookingRepository;
  let bookSeatsOnce: BookSeatsOnce;

  beforeEach(async () => {
    events = new InMemoryEventRepository();
    bookings = new InMemoryBookingRepository(events);
    await events.create(event);
    const bookSeats = new BookSeats(
      events,
      bookings,
      new RecordingPublisher(),
      recordingTelemetry(),
      fixedClock(),
      sequentialIds(),
    );
    bookSeatsOnce = makeIdempotentBookSeats(bookSeats, new InMemoryIdempotencyStore());
  });

  const book = (init: { key?: string; body?: unknown; sub?: string; eventId?: string } = {}) =>
    makeBookSeatsHandler({ bookSeats: bookSeatsOnce, logger })(
      httpEvent({
        method: "POST",
        pathParameters: { eventId: init.eventId ?? event.id },
        headers: init.key === undefined ? {} : { "idempotency-key": init.key },
        body: init.body ?? { seats: 2 },
        sub: init.sub ?? "user-1",
        groups: "[attendees]",
      }),
    );

  it("books seats (201) and replays the same booking for a retried key", async () => {
    const first = await book({ key: "key-00000001" });
    const retry = await book({ key: "key-00000001" });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(parseBody(retry)).toEqual(parseBody(first));
    expect(bookings.bookings.size).toBe(1);
    expect((await events.findById(event.id))?.seatsRemaining).toBe(3);
  });

  it("scopes keys per user, so the same key from another user is a new booking", async () => {
    await book({ key: "key-00000001", sub: "a" });
    const other = await book({ key: "key-00000001", sub: "b" });
    expect(other.statusCode).toBe(201);
    expect(bookings.bookings.size).toBe(2);
  });

  it("rejects a reused key with a different body (422)", async () => {
    await book({ key: "key-00000001" });
    const reused = await book({ key: "key-00000001", body: { seats: 3 } });
    expect(reused.statusCode).toBe(422);
    expect(parseBody(reused)["code"]).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("does not store failures, so a retry after a fix runs again", async () => {
    const tooMany = await book({ key: "key-00000001", body: { seats: 6 } });
    expect(parseBody(tooMany)["code"]).toBe("SOLD_OUT");
    expect((await book({ key: "key-00000002", body: { seats: 5 } })).statusCode).toBe(201);
  });

  it.each([
    ["a missing key", undefined],
    ["a short key", "short"],
    ["a key with spaces", "has spaces in it"],
  ])("rejects %s (400)", async (_name, key) => {
    const res = await book(key === undefined ? {} : { key });
    expect(res.statusCode).toBe(400);
  });

  it("rejects bad seat counts and bad event ids (400)", async () => {
    expect((await book({ key: "key-00000001", body: { seats: 11 } })).statusCode).toBe(400);
    expect((await book({ key: "key-00000001", eventId: "nope" })).statusCode).toBe(400);
  });

  it("cancels a booking and lists the caller's bookings", async () => {
    const booked = parseBody(await book({ key: "key-00000001" }));
    const cancelHandler = makeCancelBookingHandler({
      cancelBooking: new CancelBooking(bookings, new RecordingPublisher(), recordingTelemetry(), fixedClock()),
      logger,
    });
    const listHandler = makeListMyBookingsHandler({ listMyBookings: new ListMyBookings(bookings), logger });

    const cancelled = await cancelHandler(
      httpEvent({ method: "DELETE", pathParameters: { eventId: event.id, bookingId: booked["id"] as string } }),
    );
    const again = await cancelHandler(
      httpEvent({ method: "DELETE", pathParameters: { eventId: event.id, bookingId: booked["id"] as string } }),
    );
    const list = parseBody(await listHandler(httpEvent()));

    expect(cancelled.statusCode).toBe(200);
    expect(parseBody(cancelled)).toMatchObject({ status: "CANCELLED", event: { title: event.title } });
    expect(again.statusCode).toBe(409);
    expect(list).toEqual({
      items: [expect.objectContaining({ id: booked["id"], status: "CANCELLED" })],
      nextCursor: null,
    });
  });

  it("rejects a cancel with an invalid path (400)", async () => {
    const handler = makeCancelBookingHandler({
      cancelBooking: new CancelBooking(bookings, new RecordingPublisher(), recordingTelemetry(), fixedClock()),
      logger,
    });
    expect((await handler(httpEvent({ pathParameters: { eventId: event.id, bookingId: "x" } }))).statusCode).toBe(400);
  });
});
