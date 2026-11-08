import { makeListMyBookingsHandler } from "../features/bookings/http/handlers.js";
import { createObservability, instrument } from "../shared/observability.js";
import { compose } from "./composition.js";

const obs = createObservability("bookings");
const root = compose(obs);

export const handler = instrument(
  makeListMyBookingsHandler({ listMyBookings: root.listMyBookings(), logger: obs.logger }),
  obs,
);
