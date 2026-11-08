import { type DynamoDBDocumentClient, paginateQuery } from "@aws-sdk/lib-dynamodb";
import { Keys, SK_PREFIX } from "../../../shared/dynamodb/keys.js";
import type { AttendeeDirectory } from "../domain/reminder.js";

/** Reads the event's ATTENDEE# items (one per active booking) from its partition, all pages. */
export class DynamoDbAttendeeDirectory implements AttendeeDirectory {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async listAttendees(eventId: string): Promise<string[]> {
    const userIds: string[] = [];
    const pages = paginateQuery(
      { client: this.db },
      {
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": Keys.event(eventId).PK, ":prefix": SK_PREFIX.attendee },
        ProjectionExpression: "SK",
      },
    );
    for await (const page of pages) {
      for (const item of page.Items ?? []) userIds.push(String(item["SK"]).slice(SK_PREFIX.attendee.length));
    }
    return userIds;
  }
}
