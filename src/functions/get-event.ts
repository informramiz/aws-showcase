import { GetEvent } from "../features/events/application/get-event.js";
import { makeGetEventHandler } from "../features/events/http/handlers.js";
import { createObservability, instrument } from "../shared/observability.js";
import { compose } from "./composition.js";

const obs = createObservability("events");
const root = compose(obs);

export const handler = instrument(
  makeGetEventHandler({ getEvent: new GetEvent(root.events()), logger: obs.logger }),
  obs,
);
