import { type DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { NotFoundError } from "../../../shared/errors.js";
import { decodeCursor, encodeCursor } from "../../../shared/dynamodb/cursor.js";
import { GSI1, GSI1_KEY_ATTRS, Keys } from "../../../shared/dynamodb/keys.js";
import {
  DEFAULT_RETRY,
  failedAt,
  type RetryPolicy,
  type TransactItems,
  transactWrite,
} from "../../../shared/dynamodb/transact.js";
import type { Page, PageRequest } from "../../../shared/page.js";
import { type Booking, BookingErrors } from "../domain/booking.js";
import type { BookingRepository } from "../domain/booking-repository.js";

/** Storage shape of a booking. Exported for the waitlist adapter, which writes a booking in its own transaction. */
export const toBookingItem = (b: Booking) => ({
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
    const items: TransactItems = [
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
    await transactWrite(
      this.db,
      items,
      (reasons) => {
        if (failedAt(reasons, 0)) {
          return reasons?.[0]?.Item === undefined
            ? new NotFoundError("EVENT_NOT_FOUND", "Event not found")
            : BookingErrors.soldOut();
        }
        if (failedAt(reasons, 1)) return BookingErrors.alreadyBooked();
        return undefined;
      },
      this.retry,
    );
  }

  async cancel(booking: Booking): Promise<void> {
    const items: TransactItems = [
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
    await transactWrite(
      this.db,
      items,
      (reasons) => {
        if (failedAt(reasons, 0) || failedAt(reasons, 2)) return BookingErrors.alreadyCancelled();
        if (failedAt(reasons, 1)) return new NotFoundError("EVENT_NOT_FOUND", "Event not found");
        return undefined;
      },
      this.retry,
    );
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
}
