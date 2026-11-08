import type { Logger } from "@aws-lambda-powertools/logger";
import { handleHttp } from "../../../shared/http/handle.js";
import { json } from "../../../shared/http/problem.js";
import { actorFrom, parseWith, pathParam } from "../../../shared/http/request.js";
import { toBookingDto } from "../../bookings/http/schemas.js";
import { eventIdParam } from "../../events/http/schemas.js";
import type { AcceptOffer } from "../application/accept-offer.js";
import type { JoinWaitlist } from "../application/join-waitlist.js";
import type { WaitlistEntry } from "../domain/waitlist.js";

export const toWaitlistEntryDto = (entry: WaitlistEntry) => ({
  eventId: entry.eventId,
  status: entry.status,
  joinedAt: entry.joinedAt,
  offerExpiresAt: entry.offerExpiresAt ?? null,
});

/** POST /events/{eventId}/waitlist (attendees, sold-out events only). */
export const makeJoinWaitlistHandler = (deps: { joinWaitlist: JoinWaitlist; logger: Logger }) =>
  handleHttp(deps.logger, async (event) => {
    const eventId = parseWith(eventIdParam, pathParam(event, "eventId"), "Invalid event id");
    return json(201, toWaitlistEntryDto(await deps.joinWaitlist.execute(actorFrom(event), eventId)));
  });

/** POST /events/{eventId}/waitlist/accept. Turns the caller's open seat offer into a booking. */
export const makeAcceptOfferHandler = (deps: { acceptOffer: AcceptOffer; logger: Logger }) =>
  handleHttp(deps.logger, async (event) => {
    const eventId = parseWith(eventIdParam, pathParam(event, "eventId"), "Invalid event id");
    return json(201, toBookingDto(await deps.acceptOffer.execute(actorFrom(event), eventId)));
  });
