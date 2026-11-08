import { makeImageUploadedHandler } from "../features/events/s3/image-uploaded.js";
import { createObservability, instrument } from "../shared/observability.js";
import { compose } from "./composition.js";

const obs = createObservability("images");
const root = compose(obs);

export const handler = instrument(makeImageUploadedHandler(root.processUploadedImage()), obs);
