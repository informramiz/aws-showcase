import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  type DynamoDBDocumentClient,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { setTimeout as sleep } from "node:timers/promises";
import { ConflictError } from "../errors.js";

export type TransactItems = NonNullable<TransactWriteCommandInput["TransactItems"]>;
export type CancellationReasons = TransactionCanceledException["CancellationReasons"];

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 25 };

/** True when the item at `index` in the transaction failed its condition expression. */
export const failedAt = (reasons: CancellationReasons, index: number): boolean =>
  reasons?.[index]?.Code === "ConditionalCheckFailed";

const isConflict = (reasons: CancellationReasons): boolean =>
  reasons?.some((r) => r.Code === "TransactionConflict") ?? false;

/**
 * Runs a `TransactWriteItems` call, mapping condition failures to domain errors. `TransactionConflict`
 * means another transaction touched the same item at the same moment; the SDK does not retry that, so
 * it is retried here with full jitter, then surfaced as a 409 the client can retry.
 */
export const transactWrite = async (
  db: DynamoDBDocumentClient,
  items: TransactItems,
  mapConditionFailure: (reasons: CancellationReasons) => Error | undefined,
  retry: RetryPolicy = DEFAULT_RETRY,
): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.send(new TransactWriteCommand({ TransactItems: items }));
      return;
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) throw error;
      const mapped = mapConditionFailure(error.CancellationReasons);
      if (mapped !== undefined) throw mapped;
      if (!isConflict(error.CancellationReasons) || attempt >= retry.maxAttempts) {
        throw new ConflictError("CONCURRENT_UPDATE", "The event is busy, please retry");
      }
      await sleep(Math.random() * retry.baseDelayMs * 2 ** attempt);
    }
  }
};
