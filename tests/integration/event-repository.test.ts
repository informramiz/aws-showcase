import { beforeAll, describe, expect, it } from "vitest";
import { DynamoDbEventRepository } from "../../src/features/events/adapters/dynamodb-event-repository.js";
import { anEvent } from "../support/fixtures.js";
import { createAppTable, localClients } from "./dynamo.js";

describe("DynamoDbEventRepository (DynamoDB Local)", () => {
  const { client, doc } = localClients();
  let repo: DynamoDbEventRepository;

  beforeAll(async () => {
    repo = new DynamoDbEventRepository(doc, await createAppTable(client));
  });

  it("stores and reads back an event", async () => {
    const event = anEvent({ id: "e-read" });
    await repo.create(event);
    expect(await repo.findById(event.id)).toEqual(event);
    expect(await repo.findById("missing")).toBeUndefined();
  });

  it("refuses to overwrite an existing event", async () => {
    const event = anEvent({ id: "e-dup" });
    await repo.create(event);
    await expect(repo.create(event)).rejects.toThrow();
  });

  it("lists upcoming events in start order across pages", async () => {
    const fresh = new DynamoDbEventRepository(doc, await createAppTable(client));
    await fresh.create(anEvent({ id: "c", startsAt: "2030-04-01T00:00:00.000Z" }));
    await fresh.create(anEvent({ id: "a", startsAt: "2030-02-01T00:00:00.000Z" }));
    await fresh.create(anEvent({ id: "b", startsAt: "2030-03-01T00:00:00.000Z" }));
    await fresh.create(anEvent({ id: "past", startsAt: "2029-01-01T00:00:00.000Z" }));
    const from = new Date("2030-01-01T00:00:00.000Z");

    const first = await fresh.listUpcoming(from, { limit: 2 });
    const second = await fresh.listUpcoming(from, { limit: 2, cursor: first.nextCursor });

    expect(first.items.map((e) => e.id)).toEqual(["a", "b"]);
    expect(second.items.map((e) => e.id)).toEqual(["c"]);
  });

  it("attaches an image, keeps the newest one and reports what it replaced", async () => {
    const event = anEvent({ id: "e-image" });
    await repo.create(event);
    const first = {
      key: "events/e/1.png",
      contentType: "image/png",
      size: 10,
      uploadedAt: "2030-01-01T00:00:00.000Z",
    } as const;
    const second = { ...first, key: "events/e/2.png", uploadedAt: "2030-01-02T00:00:00.000Z" };

    expect(await repo.attachImage(event.id, first)).toEqual({ status: "attached" });
    expect(await repo.attachImage(event.id, second)).toEqual({ status: "attached", replaced: first });
    expect(await repo.attachImage(event.id, first)).toEqual({ status: "stale" });
    expect(await repo.attachImage(event.id, second)).toEqual({ status: "attached", replaced: second });
    expect(await repo.attachImage("missing", first)).toEqual({ status: "event_not_found" });
    expect((await repo.findById(event.id))?.image).toEqual(second);
  });
});
