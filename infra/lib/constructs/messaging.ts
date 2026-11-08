import type { RemovalPolicy } from "aws-cdk-lib";
import { Duration } from "aws-cdk-lib";
import { EventBus, Rule } from "aws-cdk-lib/aws-events";
import { SqsQueue } from "aws-cdk-lib/aws-events-targets";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { BOOKING_EVENT_SOURCE } from "../../../src/features/bookings/domain/booking-events.js";

export interface MessagingProps {
  readonly removalPolicy: RemovalPolicy;
  /** Must be at least the worker timeout so a message is not redelivered while still being processed. */
  readonly workerTimeout: Duration;
}

/**
 * Custom event bus -> rule -> SQS queue (with DLQ). The queue decouples the notification worker from
 * the API: bursts are buffered and failed messages are retried, then parked in the DLQ.
 */
export class Messaging extends Construct {
  readonly bus: EventBus;
  readonly queue: Queue;
  readonly deadLetterQueue: Queue;
  /** On-failure destination for stream consumers: metadata of batches that ran out of retries. */
  readonly streamFailures: Queue;

  constructor(scope: Construct, id: string, props: MessagingProps) {
    super(scope, id);

    this.bus = new EventBus(this, "Bus");

    this.deadLetterQueue = new Queue(this, "NotificationsDlq", {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: props.removalPolicy,
    });

    this.queue = new Queue(this, "NotificationsQueue", {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      // AWS guidance: visibility timeout of at least 6x the function timeout for SQS event sources.
      visibilityTimeout: Duration.seconds(props.workerTimeout.toSeconds() * 6),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 3 },
      removalPolicy: props.removalPolicy,
    });

    this.streamFailures = new Queue(this, "StreamFailuresQueue", {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: props.removalPolicy,
    });

    new Rule(this, "BookingEventsRule", {
      eventBus: this.bus,
      eventPattern: { source: [BOOKING_EVENT_SOURCE], detailType: ["BookingConfirmed", "BookingCancelled"] },
      targets: [new SqsQueue(this.queue)],
    });
  }
}
