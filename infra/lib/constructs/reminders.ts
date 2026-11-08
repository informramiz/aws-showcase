import type { RemovalPolicy } from "aws-cdk-lib";
import { Duration, Stack } from "aws-cdk-lib";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import type { Function as LambdaFunction, IFunction } from "aws-cdk-lib/aws-lambda";
import { ScheduleGroup } from "aws-cdk-lib/aws-scheduler";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export interface RemindersProps {
  /** The function each one-time schedule invokes with `{eventId}`. */
  readonly target: IFunction;
  readonly removalPolicy: RemovalPolicy;
}

/** Fixed name so the IAM resource (and its cdk-nag acknowledgement) is the same in every stack. */
export const REMINDER_SCHEDULE_GROUP = "bookings-reminders";
/** Schedules are named `reminder-<eventId>` by the app (EventBridgeReminderScheduler). */
export const REMINDER_SCHEDULE_PREFIX = "reminder-";

/**
 * EventBridge Scheduler resources for event reminders: a schedule group, the role Scheduler assumes to
 * invoke the target, and a dead-letter queue for invocations that ran out of retries. The schedules
 * themselves are created at runtime, one per event, so they are not in this template.
 * https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html#one-time
 */
export class Reminders extends Construct {
  readonly group: ScheduleGroup;
  readonly schedulerRole: Role;
  readonly deadLetterQueue: Queue;
  private readonly target: IFunction;

  constructor(scope: Construct, id: string, props: RemindersProps) {
    super(scope, id);
    this.target = props.target;

    this.group = new ScheduleGroup(this, "Group", {
      scheduleGroupName: REMINDER_SCHEDULE_GROUP,
      removalPolicy: props.removalPolicy,
    });

    this.deadLetterQueue = new Queue(this, "RemindersDlq", {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: props.removalPolicy,
    });

    // Confused-deputy guard: only Scheduler acting for this account can assume the role.
    // https://docs.aws.amazon.com/scheduler/latest/UserGuide/setting-up.html#setting-up-execution-role
    this.schedulerRole = new Role(this, "SchedulerRole", {
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com").withConditions({
        StringEquals: { "aws:SourceAccount": Stack.of(this).account },
      }),
    });
    // Exact function ARN (grantInvoke would add `:*` for versions and aliases, which this does not use).
    this.schedulerRole.addToPolicy(
      new PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [props.target.functionArn] }),
    );
    this.deadLetterQueue.grantSendMessages(this.schedulerRole);
  }

  /** Lets `fn` create reminder schedules in this group (and only there), and tells it where. */
  grantCreateReminders(fn: LambdaFunction): void {
    const stack = Stack.of(this);
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["scheduler:CreateSchedule"],
        resources: [
          stack.formatArn({
            service: "scheduler",
            resource: "schedule",
            resourceName: `${this.group.scheduleGroupName}/${REMINDER_SCHEDULE_PREFIX}*`,
          }),
        ],
      }),
    );
    this.schedulerRole.grantPassRole(fn.grantPrincipal);
    fn.addEnvironment("SCHEDULE_GROUP_NAME", this.group.scheduleGroupName);
    fn.addEnvironment("REMINDER_FUNCTION_ARN", this.target.functionArn);
    fn.addEnvironment("SCHEDULER_ROLE_ARN", this.schedulerRole.roleArn);
    fn.addEnvironment("REMINDER_DLQ_ARN", this.deadLetterQueue.queueArn);
  }
}
