import { BatchProcessor, EventType, processPartialResponse } from "@aws-lambda-powertools/batch";
import type { Context, SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import type { SendNotification } from "../application/send-notification.js";

/**
 * SQS batch handler with partial batch responses: only the failed messages go back to the queue (and
 * after `maxReceiveCount` to the DLQ), the rest are deleted. Needs `reportBatchItemFailures` on the
 * event source mapping.
 */
export const makeNotificationWorker = (useCase: SendNotification) => {
  const processor = new BatchProcessor(EventType.SQS);
  const recordHandler = (record: SQSRecord): Promise<void> => useCase.execute(record.body);
  return (event: SQSEvent, context: Context): Promise<SQSBatchResponse> =>
    processPartialResponse(event, recordHandler, processor, { context });
};
