import { makeAcceptOfferHandler } from "../features/waitlist/http/handlers.js";
import { createObservability, instrument } from "../shared/observability.js";
import { compose } from "./composition.js";

const obs = createObservability("waitlist");
const root = compose(obs);

export const handler = instrument(makeAcceptOfferHandler({ acceptOffer: root.acceptOffer(), logger: obs.logger }), obs);
