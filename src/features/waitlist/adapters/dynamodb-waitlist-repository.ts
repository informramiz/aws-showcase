import { type DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { NotFoundError } from "../../../shared/errors.js";
import { GSI1, Keys } from "../../../shared/dynamodb/keys.js";
import {
  DEFAULT_RETRY,
  failedAt,
  type RetryPolicy,
  type TransactItems,
  transactWrite,
} from "../../../shared/dynamodb/transact.js";
import type { Booking } from "../../bookings/domain/booking.js";
import { toBookingItem } from "../../bookings/adapters/dynamodb-booking-repository.js";
import { type OfferResolution, type OfferResult, type WaitlistEntry, WaitlistErrors } from "../domain/waitlist.js";
import type { WaitlistRepository } from "../domain/waitlist-repository.js";

/** GSI1 has no consistent reads, so the head of the queue can be stale; try the next few on a clash. */
const MAX_OFFER_CANDIDATES = 5;

const fromItem = (item: Record<string, unknown>): WaitlistEntry => {
  const e = item as unknown as WaitlistEntry;
  return {
    eventId: e.eventId,
    userId: e.userId,
    status: e.status,
    joinedAt: e.joinedAt,
    ...(e.offerExpiresAt === undefined ? {} : { offerExpiresAt: e.offerExpiresAt }),
  };
};

/** Internal outcomes of one offer attempt, mapped from transaction condition failures. */
class StaleCandidate extends Error {}
class NoSeat extends Error {}
class AcceptedMeanwhile extends Error {}

/**
 * Waitlist on the single table (see `keys.ts`). The seat count on the event item stays the one source
 * of truth: an offer takes a seat off it, an expired offer puts it back, each in the same transaction
 * as the entry's status change, so a seat can never be both offered and booked.
 */
export class DynamoDbWaitlistRepository implements WaitlistRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
  ) {}

  async join(entry: WaitlistEntry): Promise<void> {
    const items: TransactItems = [
      {
        ConditionCheck: {
          TableName: this.tableName,
          Key: Keys.event(entry.eventId),
          ConditionExpression: "attribute_exists(PK) AND seatsRemaining = :zero",
          ExpressionAttributeValues: { ":zero": 0 },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        },
      },
      {
        ConditionCheck: {
          TableName: this.tableName,
          Key: Keys.attendee(entry.eventId, entry.userId),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            ...Keys.waitlistEntry(entry.eventId, entry.userId),
            ...Keys.waitlistQueue(entry.eventId, entry.joinedAt, entry.userId),
            type: "WaitlistEntry",
            ...entry,
          },
          // A past EXPIRED or ACCEPTED entry may be replaced; an open one may not.
          ConditionExpression: "attribute_not_exists(PK) OR NOT (#status IN (:waiting, :offered))",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":waiting": "WAITING", ":offered": "OFFERED" },
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
            : WaitlistErrors.seatsAvailable();
        }
        if (failedAt(reasons, 1)) return WaitlistErrors.alreadyBooked();
        if (failedAt(reasons, 2)) return WaitlistErrors.alreadyWaitlisted();
        return undefined;
      },
      this.retry,
    );
  }

  async find(eventId: string, userId: string): Promise<WaitlistEntry | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.tableName, Key: Keys.waitlistEntry(eventId, userId), ConsistentRead: true }),
    );
    return Item === undefined ? undefined : fromItem(Item);
  }

  async offerNext(eventId: string, now: Date, offerExpiresAt: Date): Promise<OfferResult> {
    const { Items = [] } = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": Keys.waitlistQueue(eventId, "", "").GSI1PK },
        Limit: MAX_OFFER_CANDIDATES,
      }),
    );
    for (const candidate of Items.map(fromItem)) {
      try {
        await this.offerTo(candidate, now, offerExpiresAt);
        return { offered: true, userId: candidate.userId, offerExpiresAt: offerExpiresAt.toISOString() };
      } catch (error) {
        if (error instanceof NoSeat) return { offered: false };
        if (!(error instanceof StaleCandidate)) throw error;
      }
    }
    return { offered: false };
  }

  private async offerTo(candidate: WaitlistEntry, now: Date, offerExpiresAt: Date): Promise<void> {
    const items: TransactItems = [
      {
        Update: {
          TableName: this.tableName,
          Key: Keys.event(candidate.eventId),
          UpdateExpression: "SET seatsRemaining = seatsRemaining - :one",
          ConditionExpression: "seatsRemaining >= :one AND startsAt > :now",
          ExpressionAttributeValues: { ":one": 1, ":now": now.toISOString() },
        },
      },
      {
        Update: {
          TableName: this.tableName,
          Key: Keys.waitlistEntry(candidate.eventId, candidate.userId),
          // Dropping the GSI1 keys takes the entry out of the queue (sparse index).
          UpdateExpression: "SET #status = :offered, offeredAt = :now, offerExpiresAt = :expires REMOVE GSI1PK, GSI1SK",
          ConditionExpression: "#status = :waiting",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":offered": "OFFERED",
            ":waiting": "WAITING",
            ":now": now.toISOString(),
            ":expires": offerExpiresAt.toISOString(),
          },
        },
      },
    ];
    await transactWrite(
      this.db,
      items,
      (reasons) => {
        if (failedAt(reasons, 0)) return new NoSeat();
        if (failedAt(reasons, 1)) return new StaleCandidate();
        return undefined;
      },
      this.retry,
    );
  }

  async accept(eventId: string, userId: string, booking: Booking, now: Date): Promise<void> {
    const items: TransactItems = [
      {
        Update: {
          TableName: this.tableName,
          Key: Keys.waitlistEntry(eventId, userId),
          UpdateExpression: "SET #status = :accepted, bookingId = :bookingId, resolvedAt = :now",
          ConditionExpression: "#status = :offered AND offerExpiresAt > :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":accepted": "ACCEPTED",
            ":offered": "OFFERED",
            ":bookingId": booking.id,
            ":now": now.toISOString(),
          },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: { ...Keys.attendee(eventId, userId), type: "Attendee", bookingId: booking.id },
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
          return reasons?.[0]?.Item?.["status"]?.S === "OFFERED"
            ? WaitlistErrors.offerExpired()
            : WaitlistErrors.noOffer();
        }
        if (failedAt(reasons, 1)) return WaitlistErrors.alreadyBooked();
        return undefined;
      },
      this.retry,
    );
  }

  async resolve(eventId: string, userId: string, now: Date): Promise<OfferResolution> {
    const entry = await this.find(eventId, userId);
    if (entry?.status === "ACCEPTED") return "accepted";
    // Already expired (a retried step) or gone: nothing to give back, the seat was returned once.
    if (entry?.status !== "OFFERED") return "expired";

    const items: TransactItems = [
      {
        Update: {
          TableName: this.tableName,
          Key: Keys.waitlistEntry(eventId, userId),
          UpdateExpression: "SET #status = :expired, resolvedAt = :now",
          ConditionExpression: "#status = :offered",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":expired": "EXPIRED", ":offered": "OFFERED", ":now": now.toISOString() },
        },
      },
      {
        Update: {
          TableName: this.tableName,
          Key: Keys.event(eventId),
          UpdateExpression: "ADD seatsRemaining :one",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: { ":one": 1 },
        },
      },
    ];
    try {
      await transactWrite(
        this.db,
        items,
        (reasons) => (failedAt(reasons, 0) ? new AcceptedMeanwhile() : undefined),
        this.retry,
      );
      return "expired";
    } catch (error) {
      // The user accepted between our read and the write: their booking stands.
      if (error instanceof AcceptedMeanwhile) return "accepted";
      throw error;
    }
  }
}
