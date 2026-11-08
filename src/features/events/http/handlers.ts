import type { Logger } from "@aws-lambda-powertools/logger";
import { handleHttp } from "../../../shared/http/handle.js";
import { json } from "../../../shared/http/problem.js";
import { actorFrom, parseJsonBody, parsePageQuery, parseWith, pathParam } from "../../../shared/http/request.js";
import type { CreateEvent } from "../application/create-event.js";
import type { CreateImageUpload } from "../application/create-image-upload.js";
import type { GetEvent } from "../application/get-event.js";
import type { ListEvents } from "../application/list-events.js";
import { createEventBody, eventIdParam, imageUploadBody, toEventDto } from "./schemas.js";

/** POST /events */
export const makeCreateEventHandler = (deps: { createEvent: CreateEvent; logger: Logger }) =>
  handleHttp(deps.logger, async (event) => {
    const body = parseJsonBody(event, createEventBody);
    const created = await deps.createEvent.execute(actorFrom(event), body);
    return json(201, toEventDto(created));
  });

/** GET /events */
export const makeListEventsHandler = (deps: { listEvents: ListEvents; logger: Logger }) =>
  handleHttp(deps.logger, async (event) => {
    const page = await deps.listEvents.execute(parsePageQuery(event));
    return json(200, { items: page.items.map(toEventDto), nextCursor: page.nextCursor ?? null });
  });

/** GET /events/{eventId} */
export const makeGetEventHandler = (deps: { getEvent: GetEvent; logger: Logger }) =>
  handleHttp(deps.logger, async (event) => {
    const eventId = parseWith(eventIdParam, pathParam(event, "eventId"), "Invalid event id");
    return json(200, toEventDto(await deps.getEvent.execute(eventId)));
  });

/** POST /events/{eventId}/image-upload-url (the event's organizer only) */
export const makeCreateImageUploadHandler = (deps: { createImageUpload: CreateImageUpload; logger: Logger }) =>
  handleHttp(deps.logger, async (event) => {
    const eventId = parseWith(eventIdParam, pathParam(event, "eventId"), "Invalid event id");
    const body = parseJsonBody(event, imageUploadBody);
    return json(201, await deps.createImageUpload.execute(actorFrom(event), eventId, body));
  });
