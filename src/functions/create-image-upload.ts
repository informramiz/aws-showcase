import { makeCreateImageUploadHandler } from "../features/events/http/handlers.js";
import { createObservability, instrument } from "../shared/observability.js";
import { compose } from "./composition.js";

const obs = createObservability("events");
const root = compose(obs);

export const handler = instrument(
  makeCreateImageUploadHandler({ createImageUpload: root.createImageUpload(), logger: obs.logger }),
  obs,
);
