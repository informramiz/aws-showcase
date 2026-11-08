import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { DynamoDBPersistenceLayer } from "@aws-lambda-powertools/idempotency/dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { SFNClient } from "@aws-sdk/client-sfn";
import type { BookingEvent } from "../features/bookings/domain/booking-events.js";
import { BookSeats } from "../features/bookings/application/book-seats.js";
import { CancelBooking } from "../features/bookings/application/cancel-booking.js";
import { ListMyBookings } from "../features/bookings/application/list-my-bookings.js";
import { DynamoDbBookingRepository } from "../features/bookings/adapters/dynamodb-booking-repository.js";
import {
  createIdempotencyConfig,
  makeIdempotentBookSeats,
} from "../features/bookings/adapters/idempotent-book-seats.js";
import { DynamoDbEventRepository } from "../features/events/adapters/dynamodb-event-repository.js";
import { S3ImageStore, S3ImageUploadSigner } from "../features/events/adapters/s3-image-storage.js";
import { CreateImageUpload } from "../features/events/application/create-image-upload.js";
import { ProcessUploadedImage } from "../features/events/application/process-uploaded-image.js";
import { DynamoDbStatsRepository } from "../features/reporting/adapters/dynamodb-stats-repository.js";
import { GetEventStats } from "../features/reporting/application/get-event-stats.js";
import { ProjectEventStats } from "../features/reporting/application/project-event-stats.js";
import { DynamoDbAttendeeDirectory } from "../features/reminders/adapters/dynamodb-attendee-directory.js";
import { EventBridgeReminderScheduler } from "../features/reminders/adapters/eventbridge-reminder-scheduler.js";
import { ScheduleEventReminder } from "../features/reminders/application/schedule-event-reminder.js";
import { SendEventReminders } from "../features/reminders/application/send-event-reminders.js";
import type { EventReminder } from "../features/reminders/domain/reminder.js";
import { DynamoDbWaitlistRepository } from "../features/waitlist/adapters/dynamodb-waitlist-repository.js";
import { StepFunctionsSeatRelease } from "../features/waitlist/adapters/step-functions-seat-release.js";
import { AcceptOffer } from "../features/waitlist/application/accept-offer.js";
import { JoinWaitlist } from "../features/waitlist/application/join-waitlist.js";
import { OfferNextSeat } from "../features/waitlist/application/offer-next-seat.js";
import { ResolveOffer } from "../features/waitlist/application/resolve-offer.js";
import { StartSeatRelease } from "../features/waitlist/application/start-seat-release.js";
import { DEFAULT_HOLD_SECONDS, type WaitlistSeatOffered } from "../features/waitlist/domain/waitlist.js";
import type { IntegrationEvent } from "../shared/events/integration-event.js";
import { EventBridgePublisher } from "../shared/events/eventbridge-publisher.js";
import { systemClock } from "../shared/clock.js";
import { requireEnv } from "../shared/config.js";
import { createDocumentClient } from "../shared/dynamodb/client.js";
import { uuidGenerator } from "../shared/ids.js";
import type { Observability } from "../shared/observability.js";
import { powertoolsTelemetry } from "../shared/telemetry.js";

/**
 * Composition root: the only place that reads environment variables and wires adapters into use
 * cases. Each Lambda entry point calls it once at cold start. SDK clients are traced through X-Ray.
 */
export const compose = ({ logger, tracer, metrics }: Observability) => {
  const dynamo = tracer.captureAWSv3Client(new DynamoDBClient({}));
  const doc = createDocumentClient(dynamo);
  const tableName = () => requireEnv("TABLE_NAME");
  const telemetry = powertoolsTelemetry(logger, metrics);

  const events = () => new DynamoDbEventRepository(doc, tableName());
  const bookings = () => new DynamoDbBookingRepository(doc, tableName());
  const publisherOf = <E extends IntegrationEvent>() =>
    new EventBridgePublisher<E>(tracer.captureAWSv3Client(new EventBridgeClient({})), requireEnv("EVENT_BUS_NAME"));
  const publisher = () => publisherOf<BookingEvent>();
  const waitlist = () => new DynamoDbWaitlistRepository(doc, tableName());

  const stats = () => new DynamoDbStatsRepository(doc, tableName(), requireEnv("IDEMPOTENCY_TABLE_NAME"), systemClock);
  const s3 = () => tracer.captureAWSv3Client(new S3Client({}));
  /** How long an offered seat is held, in seconds. Read by the offer task; the Wait state uses its output. */
  const holdSeconds = () => {
    const value = Number(process.env["HOLD_SECONDS"] ?? DEFAULT_HOLD_SECONDS);
    if (!Number.isInteger(value) || value <= 0) throw new Error("HOLD_SECONDS must be a positive integer");
    return value;
  };

  return {
    events,
    createImageUpload: () =>
      new CreateImageUpload(events(), new S3ImageUploadSigner(s3(), requireEnv("BUCKET_NAME")), uuidGenerator),
    processUploadedImage: () =>
      new ProcessUploadedImage(events(), new S3ImageStore(s3(), requireEnv("BUCKET_NAME")), telemetry),
    bookSeatsOnce: () => {
      const config = createIdempotencyConfig();
      const store = new DynamoDBPersistenceLayer({
        tableName: requireEnv("IDEMPOTENCY_TABLE_NAME"),
        awsSdkV3Client: dynamo,
      });
      const bookSeats = new BookSeats(events(), bookings(), publisher(), telemetry, systemClock, uuidGenerator);
      return { config, bookSeats: makeIdempotentBookSeats(bookSeats, store, config) };
    },
    cancelBooking: () => new CancelBooking(bookings(), publisher(), telemetry, systemClock),
    listMyBookings: () => new ListMyBookings(bookings()),
    getEventStats: () => new GetEventStats(events(), stats()),
    projectEventStats: () => new ProjectEventStats(stats(), telemetry),
    holdSeconds,
    joinWaitlist: () => new JoinWaitlist(events(), waitlist(), telemetry, systemClock),
    acceptOffer: () => new AcceptOffer(events(), waitlist(), publisher(), telemetry, systemClock, uuidGenerator),
    offerNextSeat: () =>
      new OfferNextSeat(waitlist(), publisherOf<WaitlistSeatOffered>(), telemetry, systemClock, holdSeconds()),
    resolveOffer: () => new ResolveOffer(waitlist(), telemetry, systemClock),
    startSeatRelease: () =>
      new StartSeatRelease(
        new StepFunctionsSeatRelease(tracer.captureAWSv3Client(new SFNClient({})), requireEnv("STATE_MACHINE_ARN")),
        telemetry,
      ),
    scheduleEventReminder: () =>
      new ScheduleEventReminder(
        new EventBridgeReminderScheduler(tracer.captureAWSv3Client(new SchedulerClient({})), {
          groupName: requireEnv("SCHEDULE_GROUP_NAME"),
          functionArn: requireEnv("REMINDER_FUNCTION_ARN"),
          roleArn: requireEnv("SCHEDULER_ROLE_ARN"),
          deadLetterQueueArn: requireEnv("REMINDER_DLQ_ARN"),
        }),
        telemetry,
        systemClock,
      ),
    sendEventReminders: () =>
      new SendEventReminders(
        events(),
        new DynamoDbAttendeeDirectory(doc, tableName()),
        publisherOf<EventReminder>(),
        telemetry,
        systemClock,
      ),
  };
};
