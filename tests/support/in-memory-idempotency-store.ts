import { IdempotencyItemAlreadyExistsError, IdempotencyItemNotFoundError } from "@aws-lambda-powertools/idempotency";
import { BasePersistenceLayer, type IdempotencyRecord } from "@aws-lambda-powertools/idempotency/persistence";

/**
 * In-memory Powertools persistence layer for unit tests. Same put rule as the DynamoDB layer: a put
 * fails while a live record exists. The real layer is covered against DynamoDB Local.
 */
export class InMemoryIdempotencyStore extends BasePersistenceLayer {
  readonly records = new Map<string, IdempotencyRecord>();

  protected _getRecord(key: string): Promise<IdempotencyRecord> {
    const record = this.records.get(key);
    if (record === undefined) return Promise.reject(new IdempotencyItemNotFoundError());
    return Promise.resolve(record);
  }

  protected _putRecord(record: IdempotencyRecord): Promise<void> {
    const existing = this.records.get(record.idempotencyKey);
    if (existing !== undefined && !existing.isExpired()) {
      return Promise.reject(new IdempotencyItemAlreadyExistsError("exists", existing));
    }
    this.records.set(record.idempotencyKey, record);
    return Promise.resolve();
  }

  protected _updateRecord(record: IdempotencyRecord): Promise<void> {
    this.records.set(record.idempotencyKey, record);
    return Promise.resolve();
  }

  protected _deleteRecord(record: IdempotencyRecord): Promise<void> {
    this.records.delete(record.idempotencyKey);
    return Promise.resolve();
  }
}
