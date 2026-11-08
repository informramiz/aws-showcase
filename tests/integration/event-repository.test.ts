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
});
