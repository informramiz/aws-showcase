import type { Logger } from "@aws-lambda-powertools/logger";
import { handleHttp } from "../../../shared/http/handle.js";
import { json } from "../../../shared/http/problem.js";
import {
  actorFrom,
  header,
  parseJsonBody,
  parsePageQuery,
  parseWith,
  pathParam,
} from "../../../shared/http/request.js";
import { eventIdParam } from "../../events/http/schemas.js";
import type { CancelBooking } from "../application/cancel-booking.js";
import type { ListMyBookings } from "../application/list-my-bookings.js";
import type { BookSeatsOnce } from "../adapters/idempotent-book-seats.js";
import { bookingPathParams, bookSeatsBody, idempotencyKeyHeader, toBookingDto } from "./schemas.js";

/** POST /events/{eventId}/bookings. Requires an `Idempotency-Key` header so retries are safe. */
export const makeBookSeatsHandler = (deps: { bookSeats: BookSeatsOnce; logger: Logger }) =>
  handleHttp(deps.logger, async (event) => {
    const eventId = parseWith(eventIdParam, pathParam(event, "eventId"), "Invalid event id");
    const key = parseWith(idempotencyKeyHeader, header(event, "Idempotency-Key"), "Invalid Idempotency-Key header");
    const { seats } = parseJsonBody(event, bookSeatsBody);
    const booking = await deps.bookSeats(actorFrom(event), key, { eventId, seats });
    return json(201, toBookingDto(booking));
  });

/** DELETE /events/{eventId}/bookings/{bookingId}. Returns the cancelled booking. */
export const makeCancelBookingHandler = (deps: { cancelBooking: CancelBooking; logger: Logger }) =>
  handleHttp(deps.logger, async (event) => {
    const { eventId, bookingId } = parseWith(bookingPathParams, event.pathParameters ?? {}, "Invalid path");
    const cancelled = await deps.cancelBooking.execute(actorFrom(event), eventId, bookingId);
    return json(200, toBookingDto(cancelled));
  });

/** GET /me/bookings */
export const makeListMyBookingsHandler = (deps: { listMyBookings: ListMyBookings; logger: Logger }) =>
  handleHttp(deps.logger, async (event) => {
    const page = await deps.listMyBookings.execute(actorFrom(event), parsePageQuery(event));
    return json(200, { items: page.items.map(toBookingDto), nextCursor: page.nextCursor ?? null });
  });
