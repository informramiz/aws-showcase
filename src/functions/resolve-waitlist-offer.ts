import { makeResolveOfferTask } from "../features/waitlist/workflow/handlers.js";
import { createObservability, instrument } from "../shared/observability.js";
import { compose } from "./composition.js";

const obs = createObservability("waitlist");
const root = compose(obs);

export const handler = instrument(makeResolveOfferTask(root.resolveOffer()), obs);
