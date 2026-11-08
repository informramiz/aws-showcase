import { makeOfferSeatTask } from "../features/waitlist/workflow/handlers.js";
import { createObservability, instrument } from "../shared/observability.js";
import { compose } from "./composition.js";

const obs = createObservability("waitlist");
const root = compose(obs);

export const handler = instrument(makeOfferSeatTask(root.offerNextSeat(), root.holdSeconds()), obs);
