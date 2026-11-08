import type { Context } from "aws-lambda";
import { makeBookSeatsHandler } from "../features/bookings/http/handlers.js";
import type { HttpEvent } from "../shared/http/request.js";
import { createObservability, instrument } from "../shared/observability.js";
import { compose } from "./composition.js";

const obs = createObservability("bookings");
const { config, bookSeats } = compose(obs).bookSeatsOnce();
const route = makeBookSeatsHandler({ bookSeats, logger: obs.logger });

export const handler = instrument((event: HttpEvent, context: Context) => {
  // Lets Powertools expire an in-progress record if this invocation times out.
  config.registerLambdaContext(context);
  return route(event);
}, obs);
