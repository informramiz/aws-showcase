import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import type { Construct } from "constructs";
import { Api } from "./constructs/api.js";
import { AppFunction } from "./constructs/app-function.js";
import { Auth } from "./constructs/auth.js";
import { Data } from "./constructs/data.js";
import { Images } from "./constructs/images.js";
import { Messaging } from "./constructs/messaging.js";
import { applyNagSuppressions } from "./nag-suppressions.js";

export interface BookingsStackProps extends StackProps {
  /** DESTROY for a throwaway demo stack; RETAIN for anything holding real data. */
  readonly removalPolicy?: RemovalPolicy;
}

export class BookingsStack extends Stack {
  constructor(scope: Construct, id: string, props: BookingsStackProps = {}) {
    super(scope, id, props);
    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    const data = new Data(this, "Data", { removalPolicy });
    const auth = new Auth(this, "Auth", { removalPolicy });
    const workerTimeout = Duration.seconds(30);
    const messaging = new Messaging(this, "Messaging", { removalPolicy, workerTimeout });
    const images = new Images(this, "Images", { removalPolicy });

    const table = { TABLE_NAME: data.table.tableName };
    const fn = (id: string, entry: string, serviceName: string, environment: Record<string, string> = table) =>
      new AppFunction(this, id, { entry, serviceName, environment, removalPolicy }).fn;

    const createEvent = fn("CreateEvent", "create-event", "events");
    const listEvents = fn("ListEvents", "list-events", "events");
    const getEvent = fn("GetEvent", "get-event", "events");
    const bookSeats = fn("BookSeats", "book-seats", "bookings", {
      ...table,
      IDEMPOTENCY_TABLE_NAME: data.idempotencyTable.tableName,
      EVENT_BUS_NAME: messaging.bus.eventBusName,
    });
    const cancelBooking = fn("CancelBooking", "cancel-booking", "bookings", {
      ...table,
      EVENT_BUS_NAME: messaging.bus.eventBusName,
    });
    const listMyBookings = fn("ListMyBookings", "list-my-bookings", "bookings");
    const imageEnv = { ...table, BUCKET_NAME: images.bucket.bucketName };
    const createImageUpload = fn("CreateImageUpload", "create-image-upload", "events", imageEnv);
    const processEventImage = fn("ProcessEventImage", "process-event-image", "images", imageEnv);
    const worker = new AppFunction(this, "NotificationWorker", {
      entry: "notification-worker",
      serviceName: "notifications",
      timeout: workerTimeout,
      removalPolicy,
    }).fn;

    // Least privilege: each function gets only the DynamoDB actions its code issues.
    data.table.grant(createEvent, "dynamodb:PutItem");
    data.table.grant(listEvents, "dynamodb:Query");
    data.table.grant(getEvent, "dynamodb:GetItem");
    data.table.grant(
      bookSeats,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:ConditionCheckItem",
    );
    data.table.grant(cancelBooking, "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem");
    data.table.grant(listMyBookings, "dynamodb:Query");
    data.table.grant(createImageUpload, "dynamodb:GetItem");
    data.table.grant(processEventImage, "dynamodb:UpdateItem");
    images.grantUpload(createImageUpload);
    images.onImageUploaded(processEventImage);
    data.idempotencyTable.grant(
      bookSeats,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
    );
    messaging.bus.grantPutEventsTo(bookSeats);
    messaging.bus.grantPutEventsTo(cancelBooking);

    worker.addEventSource(
      new SqsEventSource(messaging.queue, { batchSize: 10, reportBatchItemFailures: true, maxConcurrency: 5 }),
    );

    const api = new Api(this, "Api", {
      userPool: auth.userPool,
      client: auth.client,
      removalPolicy,
      throttle: { rateLimit: 50, burstLimit: 100 },
      routes: [
        { method: HttpMethod.POST, path: "/events", handler: createEvent },
        { method: HttpMethod.GET, path: "/events", handler: listEvents },
        { method: HttpMethod.GET, path: "/events/{eventId}", handler: getEvent },
        { method: HttpMethod.POST, path: "/events/{eventId}/bookings", handler: bookSeats },
        { method: HttpMethod.DELETE, path: "/events/{eventId}/bookings/{bookingId}", handler: cancelBooking },
        { method: HttpMethod.GET, path: "/me/bookings", handler: listMyBookings },
        { method: HttpMethod.POST, path: "/events/{eventId}/image-upload-url", handler: createImageUpload },
      ],
    });

    new CfnOutput(this, "ApiUrl", { value: api.httpApi.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: auth.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: auth.client.userPoolClientId });
    new CfnOutput(this, "DeadLetterQueueUrl", { value: messaging.deadLetterQueue.queueUrl });
    new CfnOutput(this, "ImagesBucketName", { value: images.bucket.bucketName });

    applyNagSuppressions(this, { table: data.table, bucket: images.bucket });
  }
}
