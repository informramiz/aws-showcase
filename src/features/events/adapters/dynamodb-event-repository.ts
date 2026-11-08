import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { decodeCursor, encodeCursor } from "../../../shared/dynamodb/cursor.js";
import { GSI1, GSI1_KEY_ATTRS, Keys } from "../../../shared/dynamodb/keys.js";
import type { Page, PageRequest } from "../../../shared/page.js";
import type { Event } from "../domain/event.js";
import type { EventImage } from "../domain/event-image.js";
import type { AttachImageResult, EventRepository } from "../domain/event-repository.js";

export interface EventItem extends Event {
  readonly PK: string;
  readonly SK: string;
  readonly GSI1PK: string;
  readonly GSI1SK: string;
  readonly type: "Event";
}

export const toEventItem = (event: Event): EventItem => ({
  ...Keys.event(event.id),
  ...Keys.eventListing(event.startsAt, event.id),
  type: "Event",
  ...event,
});

export const fromEventItem = (item: Record<string, unknown>): Event => {
  const e = item as unknown as EventItem;
  return {
    id: e.id,
    title: e.title,
    venue: e.venue,
    startsAt: e.startsAt,
    capacity: e.capacity,
    seatsRemaining: e.seatsRemaining,
    organizerId: e.organizerId,
    createdAt: e.createdAt,
    ...(e.image === undefined ? {} : { image: e.image }),
  };
};

export class DynamoDbEventRepository implements EventRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async create(event: Event): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        Item: toEventItem(event),
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  }

  async findById(eventId: string): Promise<Event | undefined> {
    // Strongly consistent so seatsRemaining reflects the latest committed booking.
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.tableName, Key: Keys.event(eventId), ConsistentRead: true }),
    );
    return Item === undefined ? undefined : fromEventItem(Item);
  }

  async listUpcoming(from: Date, page: PageRequest): Promise<Page<Event>> {
    const { Items = [], LastEvaluatedKey } = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk AND GSI1SK >= :from",
        ExpressionAttributeValues: { ":pk": "EVENTS", ":from": from.toISOString() },
        Limit: page.limit,
        ExclusiveStartKey: decodeCursor(page.cursor, GSI1_KEY_ATTRS),
      }),
    );
    const nextCursor = encodeCursor(LastEvaluatedKey);
    return { items: Items.map(fromEventItem), ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  async attachImage(eventId: string, image: EventImage): Promise<AttachImageResult> {
    try {
      const { Attributes } = await this.db.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: Keys.event(eventId),
          UpdateExpression: "SET #image = :image",
          ConditionExpression: "attribute_exists(PK) AND (attribute_not_exists(#image) OR #image.uploadedAt <= :at)",
          ExpressionAttributeNames: { "#image": "image" },
          ExpressionAttributeValues: { ":image": image, ":at": image.uploadedAt },
          ReturnValues: "UPDATED_OLD",
          // An item in the failure tells "a newer image is already there" from "no such event".
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
      const replaced = Attributes?.["image"] as EventImage | undefined;
      return { status: "attached", ...(replaced === undefined ? {} : { replaced }) };
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      return error.Item === undefined ? { status: "event_not_found" } : { status: "stale" };
    }
  }
}
