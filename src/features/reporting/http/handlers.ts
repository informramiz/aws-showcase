import type { Logger } from "@aws-lambda-powertools/logger";
import { handleHttp } from "../../../shared/http/handle.js";
import { json } from "../../../shared/http/problem.js";
import { actorFrom, parseWith, pathParam } from "../../../shared/http/request.js";
import { eventIdParam } from "../../events/http/schemas.js";
import type { GetEventStats } from "../application/get-event-stats.js";
import type { EventStats } from "../domain/event-stats.js";

export const toStatsDto = (stats: EventStats) => ({
  eventId: stats.eventId,
  bookingsConfirmed: stats.bookingsConfirmed,
  bookingsCancelled: stats.bookingsCancelled,
  seatsBooked: stats.seatsBooked,
  waitlist: {
    joined: stats.waitlistJoined,
    waiting: stats.waitlistWaiting,
    offersMade: stats.offersMade,
    offersAccepted: stats.offersAccepted,
    offersExpired: stats.offersExpired,
  },
  updatedAt: stats.updatedAt ?? null,
});

/** GET /events/{eventId}/stats (the event's organizer only). Eventually consistent: fed by the stream. */
export const makeGetEventStatsHandler = (deps: { getEventStats: GetEventStats; logger: Logger }) =>
  handleHttp(deps.logger, async (event) => {
    const eventId = parseWith(eventIdParam, pathParam(event, "eventId"), "Invalid event id");
    return json(200, toStatsDto(await deps.getEventStats.execute(actorFrom(event), eventId)));
  });
