import { makeSendRemindersHandler } from "../features/reminders/scheduler/handler.js";
import { createObservability, instrument } from "../shared/observability.js";
import { compose } from "./composition.js";

const obs = createObservability("reminders");
const root = compose(obs);

export const handler = instrument(makeSendRemindersHandler(root.sendEventReminders()), obs);
