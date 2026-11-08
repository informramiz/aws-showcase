import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { DynamoDBPersistenceLayer } from "@aws-lambda-powertools/idempotency/dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BookSeats } from "../features/bookings/application/book-seats.js";
import { CancelBooking } from "../features/bookings/application/cancel-booking.js";
import { ListMyBookings } from "../features/bookings/application/list-my-bookings.js";
import { DynamoDbBookingRepository } from "../features/bookings/adapters/dynamodb-booking-repository.js";
import { EventBridgeBookingPublisher } from "../features/bookings/adapters/eventbridge-publisher.js";
import {
  createIdempotencyConfig,
  makeIdempotentBookSeats,
} from "../features/bookings/adapters/idempotent-book-seats.js";
import { DynamoDbEventRepository } from "../features/events/adapters/dynamodb-event-repository.js";
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
  const publisher = () =>
    new EventBridgeBookingPublisher(tracer.captureAWSv3Client(new EventBridgeClient({})), requireEnv("EVENT_BUS_NAME"));

  return {
    events,
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
  };
};
