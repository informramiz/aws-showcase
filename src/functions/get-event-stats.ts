import { makeGetEventStatsHandler } from "../features/reporting/http/handlers.js";
import { createObservability, instrument } from "../shared/observability.js";
import { compose } from "./composition.js";

const obs = createObservability("reporting");
const root = compose(obs);

export const handler = instrument(
  makeGetEventStatsHandler({ getEventStats: root.getEventStats(), logger: obs.logger }),
  obs,
);
