import { makeCancelBookingHandler } from "../features/bookings/http/handlers.js";
import { createObservability, instrument } from "../shared/observability.js";
import { compose } from "./composition.js";

const obs = createObservability("bookings");
const root = compose(obs);

export const handler = instrument(
  makeCancelBookingHandler({ cancelBooking: root.cancelBooking(), logger: obs.logger }),
  obs,
);
