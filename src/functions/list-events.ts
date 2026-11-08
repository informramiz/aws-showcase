import { ListEvents } from "../features/events/application/list-events.js";
import { makeListEventsHandler } from "../features/events/http/handlers.js";
import { systemClock } from "../shared/clock.js";
import { createObservability, instrument } from "../shared/observability.js";
import { compose } from "./composition.js";

const obs = createObservability("events");
const root = compose(obs);

export const handler = instrument(
  makeListEventsHandler({ listEvents: new ListEvents(root.events(), systemClock), logger: obs.logger }),
  obs,
);
