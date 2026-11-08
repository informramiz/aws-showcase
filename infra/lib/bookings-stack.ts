import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { FilterCriteria, FilterRule, type IFunction, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource, SqsDlq, SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import type { Construct } from "constructs";
import { Api } from "./constructs/api.js";
import { AppFunction } from "./constructs/app-function.js";
import { Auth } from "./constructs/auth.js";
import { Data } from "./constructs/data.js";
import { Images } from "./constructs/images.js";
import { Messaging } from "./constructs/messaging.js";
import { Reminders } from "./constructs/reminders.js";
import { WaitlistWorkflow } from "./constructs/waitlist-workflow.js";
import { applyNagSuppressions } from "./nag-suppressions.js";
import { EVENT_META_SK, SK_PREFIX } from "../../src/shared/dynamodb/keys.js";

/** How long a waitlisted person has to accept a freed seat before it moves to the next person. */
const WAITLIST_HOLD = Duration.minutes(15);

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
    const getEventStats = fn("GetEventStats", "get-event-stats", "reporting");
    const projectEventStats = fn("ProjectEventStats", "project-event-stats", "reporting", {
      ...table,
      IDEMPOTENCY_TABLE_NAME: data.idempotencyTable.tableName,
    });
    const bus = { ...table, EVENT_BUS_NAME: messaging.bus.eventBusName };
    const joinWaitlist = fn("JoinWaitlist", "join-waitlist", "waitlist");
    const acceptOffer = fn("AcceptWaitlistOffer", "accept-waitlist-offer", "waitlist", bus);
    const offerSeat = fn("OfferWaitlistSeat", "offer-waitlist-seat", "waitlist", {
      ...bus,
      HOLD_SECONDS: String(WAITLIST_HOLD.toSeconds()),
    });
    const resolveOffer = fn("ResolveWaitlistOffer", "resolve-waitlist-offer", "waitlist");
    const sendReminders = fn("SendEventReminders", "send-event-reminders", "reminders", bus);
    const tableTriggers = fn("TableChangeTriggers", "table-change-triggers", "triggers");
    const workflow = new WaitlistWorkflow(this, "WaitlistWorkflow", { offerSeat, resolveOffer, removalPolicy });
    const reminders = new Reminders(this, "Reminders", { target: sendReminders, removalPolicy });
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
    data.table.grant(getEventStats, "dynamodb:GetItem");
    data.table.grant(projectEventStats, "dynamodb:UpdateItem");
    data.idempotencyTable.grant(projectEventStats, "dynamodb:PutItem");
    data.table.grant(joinWaitlist, "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:ConditionCheckItem");
    data.table.grant(acceptOffer, "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem");
    data.table.grant(offerSeat, "dynamodb:Query", "dynamodb:UpdateItem");
    data.table.grant(resolveOffer, "dynamodb:GetItem", "dynamodb:UpdateItem");
    data.table.grant(sendReminders, "dynamodb:GetItem", "dynamodb:Query");
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
    for (const publisher of [acceptOffer, offerSeat, sendReminders]) messaging.bus.grantPutEventsTo(publisher);
    workflow.stateMachine.grantStartExecution(tableTriggers);
    tableTriggers.addEnvironment("STATE_MACHINE_ARN", workflow.stateMachine.stateMachineArn);
    reminders.grantCreateReminders(tableTriggers);

    worker.addEventSource(
      new SqsEventSource(messaging.queue, { batchSize: 10, reportBatchItemFailures: true, maxConcurrency: 5 }),
    );

    // DynamoDB Streams consumers. Event filters drop unrelated changes before Lambda is invoked (no
    // cost for them); failed records are retried with bisecting, then parked in a queue for replay.
    const consumeStream = (consumer: IFunction, filters: Record<string, unknown>[]) => {
      consumer.addEventSource(
        // TableV2 implements ITable at runtime; the cast only bridges the optional tableStreamArn typing
        // under exactOptionalPropertyTypes (the stream is enabled in DataStore).
        new DynamoEventSource(data.table as ITable, {
          startingPosition: StartingPosition.TRIM_HORIZON,
          batchSize: 25,
          bisectBatchOnError: true,
          retryAttempts: 5,
          reportBatchItemFailures: true,
          filters: filters.map((f) => FilterCriteria.filter(f)),
          onFailure: new SqsDlq(messaging.streamFailures),
        }),
      );
    };
    const skStartsWith = (prefix: string) => ({ dynamodb: { Keys: { SK: { S: FilterRule.beginsWith(prefix) } } } });
    consumeStream(projectEventStats, [skStartsWith(SK_PREFIX.booking), skStartsWith(SK_PREFIX.waitlist)]);
    // Second (and last allowed) consumer: a confirmed booking turning cancelled starts the waitlist
    // workflow; a new event schedules its reminder.
    consumeStream(tableTriggers, [
      {
        eventName: ["MODIFY"],
        dynamodb: {
          Keys: { SK: { S: FilterRule.beginsWith(SK_PREFIX.booking) } },
          OldImage: { status: { S: ["CONFIRMED"] } },
          NewImage: { status: { S: ["CANCELLED"] } },
        },
      },
      { eventName: ["INSERT"], dynamodb: { Keys: { SK: { S: [EVENT_META_SK] } } } },
    ]);

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
        { method: HttpMethod.GET, path: "/events/{eventId}/stats", handler: getEventStats },
        { method: HttpMethod.POST, path: "/events/{eventId}/waitlist", handler: joinWaitlist },
        { method: HttpMethod.POST, path: "/events/{eventId}/waitlist/accept", handler: acceptOffer },
      ],
    });

    new CfnOutput(this, "ApiUrl", { value: api.httpApi.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: auth.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: auth.client.userPoolClientId });
    new CfnOutput(this, "DeadLetterQueueUrl", { value: messaging.deadLetterQueue.queueUrl });
    new CfnOutput(this, "StreamFailuresQueueUrl", { value: messaging.streamFailures.queueUrl });
    new CfnOutput(this, "WaitlistStateMachineArn", { value: workflow.stateMachine.stateMachineArn });
    new CfnOutput(this, "RemindersDeadLetterQueueUrl", { value: reminders.deadLetterQueue.queueUrl });
    new CfnOutput(this, "ImagesBucketName", { value: images.bucket.bucketName });

    applyNagSuppressions(this, {
      table: data.table,
      bucket: images.bucket,
      workflowTasks: [offerSeat, resolveOffer],
    });
  }
}
