import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { BatchProcessor, EventType, processPartialResponse } from "@aws-lambda-powertools/batch";
import type { Context, DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";

export type ChangeKind = "INSERT" | "MODIFY" | "REMOVE";
export type Item = Record<string, unknown>;

/**
 * One DynamoDB Streams record as plain objects. `id` is the stream record's `eventID`, unique per
 * change, so consumers use it to make at-least-once delivery effectively exactly-once.
 */
export interface StreamChange {
  readonly id: string;
  readonly kind: ChangeKind;
  /** When DynamoDB wrote the change (ISO 8601, second precision). */
  readonly at: string;
  readonly oldImage?: Item;
  readonly newImage?: Item;
}

const image = (raw: Record<string, unknown> | undefined): Item | undefined =>
  raw === undefined ? undefined : unmarshall(raw as Record<string, AttributeValue>);

/** Converts a stream record (table stream view type NEW_AND_OLD_IMAGES) to a `StreamChange`. */
export const toStreamChange = (record: DynamoDBRecord): StreamChange => {
  if (record.eventID === undefined || record.eventName === undefined) {
    throw new Error("Stream record without eventID or eventName");
  }
  const createdSeconds = record.dynamodb?.ApproximateCreationDateTime;
  if (createdSeconds === undefined) throw new Error("Stream record without ApproximateCreationDateTime");
  const oldImage = image(record.dynamodb?.OldImage);
  const newImage = image(record.dynamodb?.NewImage);
  return {
    id: record.eventID,
    kind: record.eventName,
    at: new Date(createdSeconds * 1000).toISOString(),
    ...(oldImage === undefined ? {} : { oldImage }),
    ...(newImage === undefined ? {} : { newImage }),
  };
};

/**
 * DynamoDB Streams batch handler with partial batch responses: a failed record is reported back so
 * Lambda retries from it (with bisecting) instead of replaying the whole batch. Records run one at a
 * time to keep per-item ordering, which consumers of one partition's changes rely on.
 */
export const makeStreamHandler = (onChange: (change: StreamChange) => Promise<void>) => {
  const processor = new BatchProcessor(EventType.DynamoDBStreams);
  const recordHandler = (record: DynamoDBRecord): Promise<void> => onChange(toStreamChange(record));
  return (event: DynamoDBStreamEvent, context: Context): Promise<DynamoDBBatchResponse> =>
    processPartialResponse(event, recordHandler, processor, { context, processInParallel: false });
};
