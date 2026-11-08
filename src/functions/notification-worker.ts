import { LogNotifier } from "../features/notifications/adapters/log-notifier.js";
import { SendNotification } from "../features/notifications/application/send-notification.js";
import { makeNotificationWorker } from "../features/notifications/sqs/worker.js";
import { createObservability, instrument } from "../shared/observability.js";

const obs = createObservability("notifications");

export const handler = instrument(makeNotificationWorker(new SendNotification(new LogNotifier(obs.logger))), obs);
