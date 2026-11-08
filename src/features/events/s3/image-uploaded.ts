import type { S3Event } from "aws-lambda";
import type { ProcessUploadedImage } from "../application/process-uploaded-image.js";

/** S3 URL-encodes object keys in event notifications, with `+` for spaces. */
export const decodeS3Key = (key: string): string => decodeURIComponent(key.replaceAll("+", " "));

/**
 * S3 ObjectCreated handler. S3 invokes Lambda asynchronously, so a thrown error is retried by Lambda
 * (twice by default); each record is processed idempotently.
 */
export const makeImageUploadedHandler = (useCase: ProcessUploadedImage) => async (event: S3Event) => {
  for (const record of event.Records) {
    await useCase.execute({
      key: decodeS3Key(record.s3.object.key),
      size: record.s3.object.size,
      createdAt: record.eventTime,
    });
  }
};
