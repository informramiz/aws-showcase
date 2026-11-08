import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { setTimeout as sleep } from "node:timers/promises";
import { ConflictError, NotFoundError } from "../../../shared/errors.js";
import { decodeCursor, encodeCursor } from "../../../shared/dynamodb/cursor.js";
import { GSI1, GSI1_KEY_ATTRS, Keys } from "../../../shared/dynamodb/keys.js";
import type { Page, PageRequest } from "../../../shared/page.js";
import { type Booking, BookingErrors } from "../domain/booking.js";
import type { BookingRepository } from "../domain/booking-repository.js";

const toBookingItem = (b: Booking) => ({
  ...Keys.booking(b.eventId, b.id),
  ...Keys.userBooking(b.userId, b.createdAt, b.id),
  type: "Booking",
  ...b,
});

const fromBookingItem = (item: Record<string, unknown>): Booking => {
  const b = item as unknown as Booking;
  return {
    id: b.id,
    eventId: b.eventId,
    userId: b.userId,
    seats: b.seats,
    status: b.status,
    createdAt: b.createdAt,
    ...(b.cancelledAt === undefined ? {} : { cancelledAt: b.cancelledAt }),
    eventTitle: b.eventTitle,
    eventStartsAt: b.eventStartsAt,
  };
};

type Items = NonNullable<TransactWriteCommandInput["TransactItems"]>;
type Reasons = TransactionCanceledException["CancellationReasons"];

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
}

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 25 };

const failedAt = (reasons: Reasons, index: number): boolean => reasons?.[index]?.Code === "ConditionalCheckFailed";
const isConflict = (reasons: Reasons): boolean => reasons?.some((r) => r.Code === "TransactionConflict") ?? false;

/**
 * Booking persistence on the single table.
 *
 * `confirm` is one `TransactWriteItems` call that decrements `seatsRemaining` only if enough seats are
 * left, claims the per-user attendee item, and writes the booking. Either all three happen or none do,
 * so concurrent requests can never take more seats than exist.
 */
export class DynamoDbBookingRepository implements BookingRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
  ) {}

  async confirm(booking: Booking): Promise<void> {
    const items: Items = [
      {
        Update: {
          TableName: this.tableName,
          Key: Keys.event(booking.eventId),
          UpdateExpression: "SET seatsRemaining = seatsRemaining - :seats",
          ConditionExpression: "attribute_exists(PK) AND seatsRemaining >= :seats",
          ExpressionAttributeValues: { ":seats": booking.seats },
          // Lets us tell "sold out" (item returned) from "event deleted" (no item) without a second read.
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: { ...Keys.attendee(booking.eventId, booking.userId), type: "Attendee", bookingId: booking.id },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: toBookingItem(booking),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
    ];
    await this.transact(items, (reasons) => {
      if (failedAt(reasons, 0)) {
        return reasons?.[0]?.Item === undefined
          ? new NotFoundError("EVENT_NOT_FOUND", "Event not found")
          : BookingErrors.soldOut();
      }
      if (failedAt(reasons, 1)) return BookingErrors.alreadyBooked();
      return undefined;
    });
  }

  async cancel(booking: Booking): Promise<void> {
    const items: Items = [
      {
        Update: {
          TableName: this.tableName,
          Key: Keys.booking(booking.eventId, booking.id),
          UpdateExpression: "SET #status = :cancelled, cancelledAt = :at",
          ConditionExpression: "#status = :confirmed",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":cancelled": "CANCELLED",
            ":confirmed": "CONFIRMED",
            ":at": booking.cancelledAt,
          },
        },
      },
      {
        Update: {
          TableName: this.tableName,
          Key: Keys.event(booking.eventId),
          UpdateExpression: "ADD seatsRemaining :seats",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: { ":seats": booking.seats },
        },
      },
      {
        Delete: {
          TableName: this.tableName,
          Key: Keys.attendee(booking.eventId, booking.userId),
          ConditionExpression: "bookingId = :bookingId",
          ExpressionAttributeValues: { ":bookingId": booking.id },
        },
      },
    ];
    await this.transact(items, (reasons) => {
      if (failedAt(reasons, 0) || failedAt(reasons, 2)) return BookingErrors.alreadyCancelled();
      if (failedAt(reasons, 1)) return new NotFoundError("EVENT_NOT_FOUND", "Event not found");
      return undefined;
    });
  }

  async findById(eventId: string, bookingId: string): Promise<Booking | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.tableName, Key: Keys.booking(eventId, bookingId), ConsistentRead: true }),
    );
    return Item === undefined ? undefined : fromBookingItem(Item);
  }

  async listByUser(userId: string, page: PageRequest): Promise<Page<Booking>> {
    const { Items = [], LastEvaluatedKey } = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :prefix)",
        ExpressionAttributeValues: { ":pk": `USER#${userId}`, ":prefix": "BOOKING#" },
        ScanIndexForward: false,
        Limit: page.limit,
        ExclusiveStartKey: decodeCursor(page.cursor, GSI1_KEY_ATTRS),
      }),
    );
    const nextCursor = encodeCursor(LastEvaluatedKey);
    return { items: Items.map(fromBookingItem), ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  /**
   * Runs a transaction, mapping condition failures to domain errors. `TransactionConflict` means another
   * transaction touched the same item at the same moment; the SDK does not retry that, so it is retried
   * here with full jitter, then surfaced as a 409 the client can retry.
   */
  private async transact(items: Items, mapConditionFailure: (reasons: Reasons) => Error | undefined): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.db.send(new TransactWriteCommand({ TransactItems: items }));
        return;
      } catch (error) {
        if (!(error instanceof TransactionCanceledException)) throw error;
        const mapped = mapConditionFailure(error.CancellationReasons);
        if (mapped !== undefined) throw mapped;
        if (!isConflict(error.CancellationReasons) || attempt >= this.retry.maxAttempts) {
          throw new ConflictError("CONCURRENT_UPDATE", "The event is busy, please retry");
        }
        await sleep(Math.random() * this.retry.baseDelayMs * 2 ** attempt);
      }
    }
  }
}
