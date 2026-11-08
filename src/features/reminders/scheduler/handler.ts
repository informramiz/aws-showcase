import { z } from "zod";
import type { SendEventReminders } from "../application/send-event-reminders.js";

const reminderInput = z.object({ eventId: z.uuid() });

/** EventBridge Scheduler target: the schedule's Input is passed through as the Lambda event. */
export const makeSendRemindersHandler = (useCase: SendEventReminders) => async (input: unknown) => {
  const { eventId } = reminderInput.parse(input);
  return { eventId, sent: await useCase.execute(eventId) };
};
