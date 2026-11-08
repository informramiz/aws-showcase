import { CreateEvent } from "../features/events/application/create-event.js";
import { makeCreateEventHandler } from "../features/events/http/handlers.js";
import { systemClock } from "../shared/clock.js";
import { uuidGenerator } from "../shared/ids.js";
import { createObservability, instrument } from "../shared/observability.js";
import { compose } from "./composition.js";

const obs = createObservability("events");
const root = compose(obs);

export const handler = instrument(
  makeCreateEventHandler({
    createEvent: new CreateEvent(root.events(), systemClock, uuidGenerator),
    logger: obs.logger,
  }),
  obs,
);
