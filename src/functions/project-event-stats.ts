import { makeStatsStreamHandler } from "../features/reporting/stream/stats-stream-handler.js";
import { createObservability, instrument } from "../shared/observability.js";
import { compose } from "./composition.js";

const obs = createObservability("reporting");
const root = compose(obs);

export const handler = instrument(makeStatsStreamHandler(root.projectEventStats()), obs);
