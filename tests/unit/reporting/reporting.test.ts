import { marshall } from "@aws-sdk/util-dynamodb";
import type { Context, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { GetEventStats } from "../../../src/features/reporting/application/get-event-stats.js";
import { ProjectEventStats } from "../../../src/features/reporting/application/project-event-stats.js";
import { deltaFor, emptyStats, type TrackedChange } from "../../../src/features/reporting/domain/event-stats.js";
import { makeGetEventStatsHandler } from "../../../src/features/reporting/http/handlers.js";
import {
  makeStatsStreamHandler,
  toTrackedChange,
} from "../../../src/features/reporting/stream/stats-stream-handler.js";
import { toStreamChange } from "../../../src/shared/dynamodb/stream.js";
import { InMemoryEventRepository, InMemoryStatsRepository } from "../../support/fakes.js";
import { anEvent, attendee, organizer, recordingTelemetry, silentLogger } from "../../support/fixtures.js";
import { httpEvent, parseBody } from "../../support/http.js";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const AT = "2030-01-01T12:00:00.000Z";
const booking = (from?: "CONFIRMED" | "CANCELLED", to?: "CONFIRMED" | "CANCELLED"): TrackedChange => ({
  entity: "booking",
  eventId: EVENT_ID,
  seats: 3,
  ...(from === undefined ? {} : { from }),
  ...(to === undefined ? {} : { to }),
});
type W = "WAITING" | "OFFERED" | "ACCEPTED" | "EXPIRED";
const waitlist = (from?: W, to?: W): TrackedChange => ({
  entity: "waitlist",
  eventId: EVENT_ID,
  ...(from === undefined ? {} : { from }),
  ...(to === undefined ? {} : { to }),
});

describe("stats deltas", () => {
  it.each([
    ["new confirmed booking", booking(undefined, "CONFIRMED"), { bookingsConfirmed: 1, seatsBooked: 3 }],
    ["cancellation", booking("CONFIRMED", "CANCELLED"), { bookingsCancelled: 1, seatsBooked: -3 }],
    ["booking update without status change", booking("CONFIRMED", "CONFIRMED"), {}],
    ["join", waitlist(undefined, "WAITING"), { waitlistJoined: 1, waitlistWaiting: 1 }],
    ["rejoin after expiry", waitlist("EXPIRED", "WAITING"), { waitlistJoined: 1, waitlistWaiting: 1 }],
    ["offer", waitlist("WAITING", "OFFERED"), { waitlistWaiting: -1, offersMade: 1 }],
    ["entry removed while waiting", waitlist("WAITING", undefined), { waitlistWaiting: -1 }],
    ["accept", waitlist("OFFERED", "ACCEPTED"), { offersAccepted: 1 }],
    ["expire", waitlist("OFFERED", "EXPIRED"), { offersExpired: 1 }],
    ["entry update without status change", waitlist("OFFERED", "OFFERED"), {}],
    ["finished entry removed", waitlist("ACCEPTED", undefined), {}],
  ])("%s", (_name, change, expected) => {
    expect(deltaFor(change)).toEqual(expected);
  });
});

describe("ProjectEventStats", () => {
  it("adds each change once and ignores changes that do not count", async () => {
    const repo = new InMemoryStatsRepository();
    const telemetry = recordingTelemetry();
    const project = new ProjectEventStats(repo, telemetry);

    expect(await project.execute("c1", booking(undefined, "CONFIRMED"), AT)).toBe("applied");
    expect(await project.execute("c1", booking(undefined, "CONFIRMED"), AT)).toBe("duplicate");
    expect(await project.execute("c2", booking("CONFIRMED", "CONFIRMED"), AT)).toBe("ignored");
    expect(await project.execute("c3", waitlist(undefined, "WAITING"), AT)).toBe("applied");

    expect(await repo.get(EVENT_ID)).toMatchObject({
      bookingsConfirmed: 1,
      seatsBooked: 3,
      waitlistWaiting: 1,
      updatedAt: AT,
    });
    expect(telemetry.counts.get("StatsDuplicateChange")).toBe(1);
  });
});

describe("GetEventStats", () => {
  const setup = () => {
    const events = new InMemoryEventRepository();
    events.events.set(EVENT_ID, anEvent());
    const stats = new InMemoryStatsRepository();
    return { stats, useCase: new GetEventStats(events, stats) };
  };

  it("returns zeros before anything is counted, then the counters", async () => {
    const { stats, useCase } = setup();
    expect(await useCase.execute(organizer(), EVENT_ID)).toEqual(emptyStats(EVENT_ID));
    await stats.apply("c1", EVENT_ID, { bookingsConfirmed: 2 }, AT);
    expect(await useCase.execute(organizer(), EVENT_ID)).toMatchObject({ bookingsConfirmed: 2 });
  });

  it("is limited to the event's own organizer and reports unknown events", async () => {
    const { useCase } = setup();
    await expect(useCase.execute(organizer("org-2"), EVENT_ID)).rejects.toMatchObject({ code: "NOT_EVENT_ORGANIZER" });
    await expect(useCase.execute(attendee(), EVENT_ID)).rejects.toMatchObject({ code: "NOT_EVENT_ORGANIZER" });
    await expect(useCase.execute(organizer(), "missing")).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("serves GET /events/{eventId}/stats", async () => {
    const { stats, useCase } = setup();
    await stats.apply("c1", EVENT_ID, { bookingsConfirmed: 1, seatsBooked: 2, offersMade: 1 }, AT);
    const handler = makeGetEventStatsHandler({ getEventStats: useCase, logger: silentLogger() });
    const ok = await handler(
      httpEvent({ pathParameters: { eventId: EVENT_ID }, sub: "org-1", groups: "[organizers]" }),
    );
    expect(ok.statusCode).toBe(200);
    expect(parseBody(ok)).toEqual({
      eventId: EVENT_ID,
      bookingsConfirmed: 1,
      bookingsCancelled: 0,
      seatsBooked: 2,
      waitlist: { joined: 0, waiting: 0, offersMade: 1, offersAccepted: 0, offersExpired: 0 },
      updatedAt: AT,
    });
    const bad = await handler(httpEvent({ pathParameters: { eventId: "nope" }, sub: "org-1", groups: "[organizers]" }));
    expect(bad.statusCode).toBe(400);
  });
});

const CREATED_SECONDS = Date.parse(AT) / 1000;
const record = (
  id: string,
  eventName: "INSERT" | "MODIFY" | "REMOVE",
  oldImage?: Record<string, unknown>,
  newImage?: Record<string, unknown>,
): DynamoDBRecord => ({
  eventID: id,
  eventName,
  eventSourceARN: "arn:aws:dynamodb:eu-west-1:123456789012:table/app/stream/2030",
  dynamodb: {
    ApproximateCreationDateTime: CREATED_SECONDS,
    SequenceNumber: id,
    ...(oldImage === undefined ? {} : { OldImage: marshall(oldImage) as never }),
    ...(newImage === undefined ? {} : { NewImage: marshall(newImage) as never }),
  },
});
const bookingItem = (status: string) => ({ type: "Booking", eventId: EVENT_ID, seats: 2, status });

describe("stats stream adapter", () => {
  it("reads stream records into tracked changes", () => {
    const insert = toStreamChange(record("e1", "INSERT", undefined, bookingItem("CONFIRMED")));
    expect(insert).toMatchObject({ id: "e1", kind: "INSERT", at: AT });
    expect(toTrackedChange(insert)).toEqual({ entity: "booking", eventId: EVENT_ID, seats: 2, to: "CONFIRMED" });

    const offer = toStreamChange(
      record(
        "e2",
        "MODIFY",
        { type: "WaitlistEntry", eventId: EVENT_ID, status: "WAITING" },
        { type: "WaitlistEntry", eventId: EVENT_ID, status: "OFFERED" },
      ),
    );
    expect(toTrackedChange(offer)).toEqual({ entity: "waitlist", eventId: EVENT_ID, from: "WAITING", to: "OFFERED" });

    const removed = toStreamChange(
      record("e3", "REMOVE", { type: "WaitlistEntry", eventId: EVENT_ID, status: "WAITING" }),
    );
    expect(toTrackedChange(removed)).toEqual({ entity: "waitlist", eventId: EVENT_ID, from: "WAITING" });
  });

  it("ignores items it does not track and rejects malformed records", () => {
    const meta = toStreamChange(record("e1", "INSERT", undefined, { type: "Event", eventId: EVENT_ID }));
    expect(toTrackedChange(meta)).toBeUndefined();
    expect(toTrackedChange(toStreamChange(record("e2", "INSERT", undefined, { type: "Booking" })))).toBeUndefined();
    expect(
      toTrackedChange(toStreamChange(record("e3", "INSERT", undefined, { type: "Booking", eventId: EVENT_ID }))),
    ).toBeUndefined();
    expect(() => toStreamChange({ eventName: "INSERT" })).toThrow("eventID");
    expect(() => toStreamChange({ eventID: "x", eventName: "INSERT", dynamodb: {} })).toThrow(
      "ApproximateCreationDateTime",
    );
  });

  it("projects a batch and reports only failed records back to Lambda", async () => {
    const repo = new InMemoryStatsRepository();
    const handler = makeStatsStreamHandler(new ProjectEventStats(repo, recordingTelemetry()));
    const event: DynamoDBStreamEvent = {
      Records: [
        record("e1", "INSERT", undefined, bookingItem("CONFIRMED")),
        record("e2", "MODIFY", bookingItem("CONFIRMED"), bookingItem("CANCELLED")),
        { eventID: "bad", eventName: "INSERT", dynamodb: { SequenceNumber: "bad" } },
        record("e1", "INSERT", undefined, bookingItem("CONFIRMED")),
      ],
    };
    const result = await handler(event, {} as Context);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "bad" }]);
    expect(await repo.get(EVENT_ID)).toMatchObject({ bookingsConfirmed: 1, bookingsCancelled: 1, seatsBooked: 0 });
  });
});
