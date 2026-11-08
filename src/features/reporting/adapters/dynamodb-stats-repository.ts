import { type DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Clock } from "../../../shared/clock.js";
import { Keys } from "../../../shared/dynamodb/keys.js";
import { failedAt, transactWrite } from "../../../shared/dynamodb/transact.js";
import { emptyStats, STAT_COUNTERS, type EventStats, type StatsDelta } from "../domain/event-stats.js";
import type { ApplyResult, StatsRepository } from "../domain/stats-repository.js";

/** Stream records live 24 hours; a marker that outlives that window can never see a redelivery. */
const DEDUPE_TTL_SECONDS = 2 * 24 * 60 * 60;

class AlreadyCounted extends Error {}

/**
 * Counters live on one `STATS` item per event. Each change is applied in a transaction together with
 * a marker keyed by the stream record ID in the idempotency table, so a redelivered record (streams
 * are at-least-once) fails the marker's condition and changes nothing.
 */
export class DynamoDbStatsRepository implements StatsRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly dedupeTableName: string,
    private readonly clock: Clock,
  ) {}

  async apply(changeId: string, eventId: string, delta: StatsDelta, at: string): Promise<ApplyResult> {
    const counters = Object.entries(delta).filter(([, v]) => v !== 0);
    const names = Object.fromEntries(counters.map(([c], i) => [`#c${String(i)}`, c]));
    const values = Object.fromEntries(counters.map(([, v], i) => [`:c${String(i)}`, v]));
    const expiration = Math.floor(this.clock.now().getTime() / 1000) + DEDUPE_TTL_SECONDS;
    try {
      await transactWrite(
        this.db,
        [
          {
            Put: {
              TableName: this.dedupeTableName,
              Item: { id: `stats#${changeId}`, expiration },
              ConditionExpression: "attribute_not_exists(id)",
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: Keys.stats(eventId),
              UpdateExpression: `SET eventId = :eventId, updatedAt = :at ADD ${counters.map((_, i) => `#c${String(i)} :c${String(i)}`).join(", ")}`,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: { ...values, ":eventId": eventId, ":at": at },
            },
          },
        ],
        (reasons) => (failedAt(reasons, 0) ? new AlreadyCounted() : undefined),
      );
      return "applied";
    } catch (error) {
      if (error instanceof AlreadyCounted) return "duplicate";
      throw error;
    }
  }

  async get(eventId: string): Promise<EventStats | undefined> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.tableName, Key: Keys.stats(eventId) }));
    if (Item === undefined) return undefined;
    const stats = { ...emptyStats(eventId), updatedAt: Item["updatedAt"] as string };
    for (const counter of STAT_COUNTERS) {
      const value: unknown = Item[counter];
      if (typeof value === "number") stats[counter] = value;
    }
    return stats;
  }
}
