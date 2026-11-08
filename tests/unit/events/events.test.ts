import { beforeEach, describe, expect, it } from "vitest";
import { createEvent, hasStarted } from "../../../src/features/events/domain/event.js";
import { CreateEvent } from "../../../src/features/events/application/create-event.js";
import { GetEvent } from "../../../src/features/events/application/get-event.js";
import { ListEvents } from "../../../src/features/events/application/list-events.js";
import {
  makeCreateEventHandler,
  makeGetEventHandler,
  makeListEventsHandler,
} from "../../../src/features/events/http/handlers.js";
import { InMemoryEventRepository } from "../../support/fakes.js";
import {
  anEvent,
  attendee,
  fixedClock,
  LATER,
  NOW,
  organizer,
  sequentialIds,
  silentLogger,
} from "../../support/fixtures.js";
import { httpEvent, parseBody } from "../../support/http.js";

describe("event domain", () => {
  const input = { id: "e1", title: "T", venue: "V", capacity: 10, organizerId: "o", now: NOW };

  it("starts with every seat available", () => {
    const event = createEvent({ ...input, startsAt: new Date(LATER) });
    expect(event).toMatchObject({ capacity: 10, seatsRemaining: 10, startsAt: LATER, createdAt: NOW.toISOString() });
  });

  it("rejects an event that starts now or earlier", () => {
    expect(() => createEvent({ ...input, startsAt: NOW })).toThrow(expect.objectContaining({ code: "EVENT_IN_PAST" }));
  });

  it("hasStarted compares with the clock", () => {
    expect(hasStarted({ startsAt: LATER }, NOW)).toBe(false);
    expect(hasStarted({ startsAt: NOW.toISOString() }, NOW)).toBe(true);
  });
});

describe("event use cases and handlers", () => {
  let repo: InMemoryEventRepository;
  const logger = silentLogger();
  const clock = fixedClock();

  beforeEach(() => {
    repo = new InMemoryEventRepository();
  });

  const createHandler = () =>
    makeCreateEventHandler({ createEvent: new CreateEvent(repo, clock, sequentialIds()), logger });
  const validBody = { title: "TypeScript Summit", venue: "Hall A", startsAt: LATER, capacity: 50 };

  it("an organizer creates an event (201)", async () => {
    const res = await createHandler()(
      httpEvent({ method: "POST", body: validBody, sub: "org-1", groups: "[organizers]" }),
    );
    expect(res.statusCode).toBe(201);
    expect(parseBody(res)).toMatchObject({ ...validBody, seatsRemaining: 50, organizerId: "org-1" });
    expect(repo.events.size).toBe(1);
  });

  it("an attendee cannot create events (403)", async () => {
    await expect(
      new CreateEvent(repo, clock, sequentialIds()).execute(attendee(), {
        ...validBody,
        startsAt: new Date(LATER),
      }),
    ).rejects.toMatchObject({ code: "ORGANIZER_ONLY" });
    const res = await createHandler()(httpEvent({ method: "POST", body: validBody, groups: "[attendees]" }));
    expect(res.statusCode).toBe(403);
  });

  it.each([
    ["unknown fields", { ...validBody, admin: true }],
    ["a timestamp without offset", { ...validBody, startsAt: "2030-02-01 18:00" }],
    ["zero capacity", { ...validBody, capacity: 0 }],
    ["a blank title", { ...validBody, title: "  " }],
  ])("rejects %s with 400", async (_name, body) => {
    const res = await createHandler()(httpEvent({ method: "POST", body, groups: "[organizers]" }));
    expect(res.statusCode).toBe(400);
  });

  it("rejects a past start with 422", async () => {
    const res = await createHandler()(
      httpEvent({ method: "POST", body: { ...validBody, startsAt: "2020-01-01T00:00:00Z" }, groups: "[organizers]" }),
    );
    expect(res.statusCode).toBe(422);
  });

  it("gets an event by id, 404 when missing, 400 when the id is not a uuid", async () => {
    const event = anEvent();
    await repo.create(event);
    const handler = makeGetEventHandler({ getEvent: new GetEvent(repo), logger });

    const found = await handler(httpEvent({ pathParameters: { eventId: event.id } }));
    const missing = await handler(httpEvent({ pathParameters: { eventId: "99999999-9999-4999-8999-999999999999" } }));
    const invalid = await handler(httpEvent({ pathParameters: { eventId: "nope" } }));

    expect(found.statusCode).toBe(200);
    expect(parseBody(found)).toMatchObject({ id: event.id, title: event.title });
    expect(missing.statusCode).toBe(404);
    expect(invalid.statusCode).toBe(400);
  });

  it("lists upcoming events with a cursor", async () => {
    await repo.create(anEvent({ id: "a", startsAt: "2030-03-01T00:00:00.000Z" }));
    await repo.create(anEvent({ id: "b", startsAt: "2030-02-01T00:00:00.000Z" }));
    await repo.create(anEvent({ id: "old", startsAt: "2029-01-01T00:00:00.000Z" }));
    const handler = makeListEventsHandler({ listEvents: new ListEvents(repo, clock), logger });

    const first = parseBody(await handler(httpEvent({ query: { limit: "1" } })));
    const second = parseBody(
      await handler(httpEvent({ query: { limit: "1", cursor: first["nextCursor"] as string } })),
    );

    expect((first["items"] as { id: string }[]).map((e) => e.id)).toEqual(["b"]);
    expect((second["items"] as { id: string }[]).map((e) => e.id)).toEqual(["a"]);
    expect(second["nextCursor"]).toBeNull();
  });

  it("organizer fixture has the organizer role", () => {
    expect(organizer().roles.has("organizers")).toBe(true);
  });
});
