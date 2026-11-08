import {
  ActionAfterCompletion,
  ConflictException,
  CreateScheduleCommand,
  FlexibleTimeWindowMode,
  type SchedulerClient,
} from "@aws-sdk/client-scheduler";
import type { ReminderScheduler } from "../domain/reminder.js";

export interface ReminderScheduleTarget {
  readonly groupName: string;
  /** The Lambda function the schedule invokes. */
  readonly functionArn: string;
  /** Role EventBridge Scheduler assumes to invoke the target and write to the DLQ. */
  readonly roleArn: string;
  readonly deadLetterQueueArn: string;
}

/** `at()` takes a UTC wall-clock time without zone or milliseconds: yyyy-mm-ddThh:mm:ss. */
const atExpression = (at: Date): string => `at(${at.toISOString().slice(0, 19)})`;

/**
 * One one-time schedule per event, named after it, deleted by Scheduler after it runs. A name clash
 * means the reminder already exists (a redelivered stream record), so it is not an error.
 * https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html#one-time
 */
export class EventBridgeReminderScheduler implements ReminderScheduler {
  constructor(
    private readonly client: SchedulerClient,
    private readonly target: ReminderScheduleTarget,
  ) {}

  async schedule(eventId: string, at: Date): Promise<"scheduled" | "exists"> {
    try {
      await this.client.send(
        new CreateScheduleCommand({
          Name: `reminder-${eventId}`,
          GroupName: this.target.groupName,
          ScheduleExpression: atExpression(at),
          ScheduleExpressionTimezone: "UTC",
          FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
          ActionAfterCompletion: ActionAfterCompletion.DELETE,
          Target: {
            Arn: this.target.functionArn,
            RoleArn: this.target.roleArn,
            Input: JSON.stringify({ eventId }),
            RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 },
            DeadLetterConfig: { Arn: this.target.deadLetterQueueArn },
          },
        }),
      );
      return "scheduled";
    } catch (error) {
      if (error instanceof ConflictException) return "exists";
      throw error;
    }
  }
}
