import { toNewEvent } from "../features/reminders/stream/reminder-trigger.js";
import { toSeatRelease } from "../features/waitlist/stream/seat-release-trigger.js";
import { makeStreamHandler } from "../shared/dynamodb/stream.js";
import { createObservability, instrument } from "../shared/observability.js";
import { compose } from "./composition.js";

const obs = createObservability("triggers");
const root = compose(obs);
const startSeatRelease = root.startSeatRelease();
const scheduleEventReminder = root.scheduleEventReminder();

/**
 * The table's second stream consumer (DynamoDB allows two per shard): starts workflows from committed
 * changes, so a lost EventBridge publish can never lose a waitlist offer or a reminder.
 */
export const handler = instrument(
  makeStreamHandler(async (change) => {
    const release = toSeatRelease(change);
    if (release !== undefined) await startSeatRelease.execute(release);
    const created = toNewEvent(change);
    if (created !== undefined) await scheduleEventReminder.execute(created.eventId, created.startsAt);
  }),
  obs,
);
