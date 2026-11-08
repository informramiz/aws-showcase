import { makeJoinWaitlistHandler } from "../features/waitlist/http/handlers.js";
import { createObservability, instrument } from "../shared/observability.js";
import { compose } from "./composition.js";

const obs = createObservability("waitlist");
const root = compose(obs);

export const handler = instrument(
  makeJoinWaitlistHandler({ joinWaitlist: root.joinWaitlist(), logger: obs.logger }),
  obs,
);
