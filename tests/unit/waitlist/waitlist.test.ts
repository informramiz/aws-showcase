import { marshall } from "@aws-sdk/util-dynamodb";
import { ExecutionAlreadyExists, type SFNClient } from "@aws-sdk/client-sfn";
import type { Context, DynamoDBRecord } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StepFunctionsSeatRelease } from "../../../src/features/waitlist/adapters/step-functions-seat-release.js";
import { AcceptOffer } from "../../../src/features/waitlist/application/accept-offer.js";
import { JoinWaitlist } from "../../../src/features/waitlist/application/join-waitlist.js";
import { OfferNextSeat } from "../../../src/features/waitlist/application/offer-next-seat.js";
import { ResolveOffer } from "../../../src/features/waitlist/application/resolve-offer.js";
import { StartSeatRelease } from "../../../src/features/waitlist/application/start-seat-release.js";
import {
  assertOfferOpen,
  joinWaitlist,
  type WaitlistSeatOffered,
} from "../../../src/features/waitlist/domain/waitlist.js";
import { makeAcceptOfferHandler, makeJoinWaitlistHandler } from "../../../src/features/waitlist/http/handlers.js";
import { toSeatRelease } from "../../../src/features/waitlist/stream/seat-release-trigger.js";
import { makeOfferSeatTask, makeResolveOfferTask } from "../../../src/features/waitlist/workflow/handlers.js";
import { ConflictError } from "../../../src/shared/errors.js";
import { makeStreamHandler, type StreamChange } from "../../../src/shared/dynamodb/stream.js";
import { InMemoryEventRepository, InMemoryWaitlistRepository, RecordingPublisher } from "../../support/fakes.js";
import {
  anEvent,
  attendee,
  fixedClock,
  NOW,
  organizer,
  recordingTelemetry,
  sequentialIds,
  silentLogger,
} from "../../support/fixtures.js";
import { httpEvent, parseBody } from "../../support/http.js";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const HOLD = 900;
const soldOut = () => anEvent({ seatsRemaining: 0 });
const at = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1000);

describe("waitlist domain", () => {
  it("only queues for a sold-out event that has not started", () => {
    expect(joinWaitlist(soldOut(), "u1", NOW)).toEqual({
      eventId: EVENT_ID,
      userId: "u1",
      status: "WAITING",
      joinedAt: NOW.toISOString(),
    });
    expect(() => joinWaitlist(anEvent({ seatsRemaining: 1 }), "u1", NOW)).toThrow(/still available/);
    expect(() => joinWaitlist(soldOut(), "u1", new Date("2031-01-01T00:00:00Z"))).toThrow(/started/);
  });

  it("accepts only an offer that is open and unexpired", () => {
    const offered = { ...joinWaitlist(soldOut(), "u1", NOW), status: "OFFERED" as const };
    expect(() => {
      assertOfferOpen(undefined, NOW);
    }).toThrow(/no seat offer/);
    expect(() => {
      assertOfferOpen(offered, NOW);
    }).toThrow(/no seat offer/);
    expect(() => {
      assertOfferOpen({ ...offered, offerExpiresAt: at(-1).toISOString() }, NOW);
    }).toThrow(/expired/);
    expect(() => {
      assertOfferOpen({ ...offered, offerExpiresAt: at(60).toISOString() }, NOW);
    }).not.toThrow();
  });
});

describe("waitlist use cases", () => {
  let events: InMemoryEventRepository;
  let waitlist: InMemoryWaitlistRepository;
  let telemetry: ReturnType<typeof recordingTelemetry>;
  let clock: ReturnType<typeof fixedClock>;
  let offers: RecordingPublisher<WaitlistSeatOffered>;
  let bookings: RecordingPublisher;

  beforeEach(async () => {
    events = new InMemoryEventRepository();
    await events.create(soldOut());
    waitlist = new InMemoryWaitlistRepository(events);
    telemetry = recordingTelemetry();
    clock = fixedClock();
    offers = new RecordingPublisher();
    bookings = new RecordingPublisher();
  });

  const join = (userId: string) =>
    new JoinWaitlist(events, waitlist, telemetry, clock).execute(attendee(userId), EVENT_ID);
  const offerNext = () => new OfferNextSeat(waitlist, offers, telemetry, clock, HOLD).execute(EVENT_ID);
  const accept = (userId: string) =>
    new AcceptOffer(events, waitlist, bookings, telemetry, clock, sequentialIds()).execute(attendee(userId), EVENT_ID);
  const resolve = (userId: string) => new ResolveOffer(waitlist, telemetry, clock).execute(EVENT_ID, userId);
  const freeSeat = () => {
    const event = events.events.get(EVENT_ID);
    if (event !== undefined) events.events.set(EVENT_ID, { ...event, seatsRemaining: event.seatsRemaining + 1 });
  };

  it("joins attendees only, once, for an existing event", async () => {
    expect((await join("u1")).status).toBe("WAITING");
    expect(telemetry.counts.get("WaitlistJoined")).toBe(1);
    await expect(join("u1")).rejects.toMatchObject({ code: "ALREADY_WAITLISTED" });
    await expect(
      new JoinWaitlist(events, waitlist, telemetry, clock).execute(organizer(), EVENT_ID),
    ).rejects.toMatchObject({ code: "ATTENDEE_ONLY" });
    await expect(
      new JoinWaitlist(events, waitlist, telemetry, clock).execute(attendee(), "missing"),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("offers a freed seat to the first in line, who accepts it as a one-seat booking", async () => {
    await join("u1");
    clock.set(at(1));
    await join("u2");
    freeSeat();

    expect(await offerNext()).toEqual({ offered: true, userId: "u1", offerExpiresAt: at(1 + HOLD).toISOString() });
    expect(offers.published).toEqual([
      expect.objectContaining({
        type: "WaitlistSeatOffered",
        userId: "u1",
        offerExpiresAt: at(1 + HOLD).toISOString(),
      }),
    ]);
    expect(events.events.get(EVENT_ID)?.seatsRemaining).toBe(0);

    const booking = await accept("u1");
    expect(booking).toMatchObject({ userId: "u1", seats: 1, status: "CONFIRMED", eventTitle: "TypeScript Summit" });
    expect(bookings.published.map((e) => e.type)).toEqual(["BookingConfirmed"]);
    expect(await resolve("u1")).toBe("accepted");
    expect(telemetry.counts.get("WaitlistOfferAccepted")).toBe(1);
  });

  it("expires an unaccepted offer and returns the seat so it can move on", async () => {
    await join("u1");
    freeSeat();
    await offerNext();
    clock.set(at(HOLD));

    await expect(accept("u1")).rejects.toMatchObject({ code: "OFFER_EXPIRED" });
    expect(await resolve("u1")).toBe("expired");
    expect(events.events.get(EVENT_ID)?.seatsRemaining).toBe(1);
    expect(telemetry.counts.get("WaitlistOfferExpired")).toBe(1);
    await expect(accept("u2")).rejects.toMatchObject({ code: "NO_OFFER" });
  });

  it("offers nothing when the queue is empty", async () => {
    freeSeat();
    expect(await offerNext()).toEqual({ offered: false });
    expect(offers.published).toEqual([]);
  });

  it("keeps the offer when publishing the notification fails", async () => {
    await join("u1");
    freeSeat();
    offers.failWith = new Error("bus down");
    expect((await offerNext()).offered).toBe(true);
    expect(telemetry.counts.get("EventPublishFailed")).toBe(1);
  });

  it("fails loudly if the event vanished under an open offer", async () => {
    await join("u1");
    freeSeat();
    await offerNext();
    events.events.delete(EVENT_ID);
    await expect(accept("u1")).rejects.toThrow(/missing/);
  });

  it("counts started and duplicate workflow starts", async () => {
    const start = vi.fn().mockResolvedValueOnce("started").mockResolvedValueOnce("duplicate");
    const useCase = new StartSeatRelease({ start }, telemetry);
    const release = { bookingId: "b1", eventId: EVENT_ID, seats: 2 };
    await useCase.execute(release);
    await useCase.execute(release);
    expect(start).toHaveBeenCalledWith(release);
    expect(telemetry.counts.get("SeatReleaseStarted")).toBe(1);
    expect(telemetry.counts.get("SeatReleaseDuplicate")).toBe(1);
  });
});

describe("waitlist workflow tasks", () => {
  it("shapes the offer output for the Choice and Wait states", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ offered: true, userId: "u1", offerExpiresAt: "x" })
      .mockResolvedValueOnce({ offered: false });
    const task = makeOfferSeatTask({ execute } as unknown as OfferNextSeat, HOLD);

    expect(await task({ eventId: EVENT_ID })).toEqual({
      eventId: EVENT_ID,
      offered: true,
      userId: "u1",
      holdSeconds: HOLD,
    });
    expect(await task({ eventId: EVENT_ID })).toEqual({ eventId: EVENT_ID, offered: false });
    await expect(task({ eventId: "nope" })).rejects.toThrow();
  });

  it("returns the resolution as the outcome", async () => {
    const execute = vi.fn().mockResolvedValue("expired");
    const task = makeResolveOfferTask({ execute } as unknown as ResolveOffer);
    expect(await task({ eventId: EVENT_ID, userId: "u1" })).toEqual({ eventId: EVENT_ID, outcome: "expired" });
    expect(execute).toHaveBeenCalledWith(EVENT_ID, "u1");
    await expect(task({ eventId: EVENT_ID })).rejects.toThrow();
  });
});

describe("seat release trigger", () => {
  const booking = (status: string) => ({ type: "Booking", id: "b1", eventId: EVENT_ID, seats: 2, status });
  const change = (kind: StreamChange["kind"], oldImage?: object, newImage?: object): StreamChange => ({
    id: "c1",
    kind,
    at: NOW.toISOString(),
    ...(oldImage === undefined ? {} : { oldImage: oldImage as Record<string, unknown> }),
    ...(newImage === undefined ? {} : { newImage: newImage as Record<string, unknown> }),
  });

  it("fires only for a confirmed booking that was cancelled", () => {
    expect(toSeatRelease(change("MODIFY", booking("CONFIRMED"), booking("CANCELLED")))).toEqual({
      bookingId: "b1",
      eventId: EVENT_ID,
      seats: 2,
    });
    expect(toSeatRelease(change("INSERT", undefined, booking("CONFIRMED")))).toBeUndefined();
    expect(toSeatRelease(change("MODIFY", booking("CANCELLED"), booking("CANCELLED")))).toBeUndefined();
    expect(toSeatRelease(change("MODIFY", { type: "Event" }, { type: "Event" }))).toBeUndefined();
    expect(
      toSeatRelease(change("MODIFY", booking("CONFIRMED"), { ...booking("CANCELLED"), seats: "2" })),
    ).toBeUndefined();
  });

  it("reports only the failing stream record back to Lambda", async () => {
    const seen: string[] = [];
    const handler = makeStreamHandler((c) => {
      if (c.id === "bad") return Promise.reject(new Error("boom"));
      seen.push(c.id);
      return Promise.resolve();
    });
    const record = (eventID: string): DynamoDBRecord => ({
      eventID,
      eventName: "INSERT",
      dynamodb: { ApproximateCreationDateTime: 1, SequenceNumber: eventID, NewImage: marshall({ PK: "x" }) as never },
    });

    const result = await handler({ Records: [record("a"), record("bad"), record("b")] }, {} as Context);

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "bad" }] });
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("waitlist HTTP", () => {
  const entry = { eventId: EVENT_ID, userId: "u1", status: "WAITING" as const, joinedAt: NOW.toISOString() };

  it("returns the new entry with 201", async () => {
    const execute = vi.fn().mockResolvedValue(entry);
    const handler = makeJoinWaitlistHandler({
      joinWaitlist: { execute } as unknown as JoinWaitlist,
      logger: silentLogger(),
    });
    const res = await handler(
      httpEvent({ method: "POST", pathParameters: { eventId: EVENT_ID }, groups: "[attendees]" }),
    );
    expect(res.statusCode).toBe(201);
    expect(parseBody(res)).toEqual({
      eventId: EVENT_ID,
      status: "WAITING",
      joinedAt: NOW.toISOString(),
      offerExpiresAt: null,
    });
    expect((await handler(httpEvent({ method: "POST", pathParameters: { eventId: "nope" } }))).statusCode).toBe(400);
  });

  it("maps an accepted offer to a booking and an expired one to 409", async () => {
    const booking = {
      id: "b1",
      eventId: EVENT_ID,
      userId: "u1",
      seats: 1,
      status: "CONFIRMED",
      createdAt: NOW.toISOString(),
      eventTitle: "T",
      eventStartsAt: NOW.toISOString(),
    };
    const execute = vi
      .fn()
      .mockResolvedValueOnce(booking)
      .mockRejectedValueOnce(new ConflictError("OFFER_EXPIRED", "expired"));
    const handler = makeAcceptOfferHandler({
      acceptOffer: { execute } as unknown as AcceptOffer,
      logger: silentLogger(),
    });
    const request = httpEvent({ method: "POST", pathParameters: { eventId: EVENT_ID }, groups: "[attendees]" });

    const ok = await handler(request);
    expect(ok.statusCode).toBe(201);
    expect(parseBody(ok)).toMatchObject({ id: "b1", seats: 1 });
    expect((await handler(request)).statusCode).toBe(409);
  });
});

describe("StepFunctionsSeatRelease", () => {
  const ARN = "arn:aws:states:eu-west-1:123456789012:stateMachine:SeatRelease";

  it("names the execution after the booking so a redelivery cannot start a second run", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new ExecutionAlreadyExists({ message: "exists", $metadata: {} }))
      .mockRejectedValueOnce(new Error("throttled"));
    const workflow = new StepFunctionsSeatRelease({ send } as unknown as SFNClient, ARN);
    const release = { bookingId: "b1", eventId: EVENT_ID, seats: 2 };

    expect(await workflow.start(release)).toBe("started");
    expect((send.mock.calls[0]?.[0] as { input: unknown } | undefined)?.input).toEqual({
      stateMachineArn: ARN,
      name: "release-b1",
      input: JSON.stringify({ eventId: EVENT_ID, seats: 2 }),
    });
    expect(await workflow.start(release)).toBe("duplicate");
    await expect(workflow.start(release)).rejects.toThrow("throttled");
  });
});
