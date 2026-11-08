import { ConflictException, type SchedulerClient } from "@aws-sdk/client-scheduler";
import { describe, expect, it, vi } from "vitest";
import { EventBridgeReminderScheduler } from "../../../src/features/reminders/adapters/eventbridge-reminder-scheduler.js";
import { ScheduleEventReminder } from "../../../src/features/reminders/application/schedule-event-reminder.js";
import { SendEventReminders } from "../../../src/features/reminders/application/send-event-reminders.js";
import { type EventReminder, reminderTime } from "../../../src/features/reminders/domain/reminder.js";
import { makeSendRemindersHandler } from "../../../src/features/reminders/scheduler/handler.js";
import { toNewEvent } from "../../../src/features/reminders/stream/reminder-trigger.js";
import type { StreamChange } from "../../../src/shared/dynamodb/stream.js";
import { InMemoryEventRepository, RecordingPublisher } from "../../support/fakes.js";
import { anEvent, fixedClock, LATER, NOW, recordingTelemetry } from "../../support/fixtures.js";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const DAY_BEFORE_LATER = new Date(Date.parse(LATER) - 24 * 3600 * 1000);

describe("reminder time", () => {
  it("is 24 hours before the start, unless that has already passed", () => {
    expect(reminderTime(LATER, NOW)).toEqual(DAY_BEFORE_LATER);
    expect(reminderTime("2030-01-02T11:00:00.000Z", NOW)).toBeUndefined();
    expect(reminderTime("2030-01-02T12:00:00.000Z", NOW)).toBeUndefined();
  });
});

describe("ScheduleEventReminder", () => {
  it("schedules once, skips events too close to start, and counts new schedules", async () => {
    const schedule = vi.fn().mockResolvedValueOnce("scheduled").mockResolvedValueOnce("exists");
    const telemetry = recordingTelemetry();
    const useCase = new ScheduleEventReminder({ schedule }, telemetry, fixedClock());

    expect(await useCase.execute(EVENT_ID, LATER)).toBe("scheduled");
    expect(await useCase.execute(EVENT_ID, LATER)).toBe("exists");
    expect(await useCase.execute(EVENT_ID, "2030-01-01T18:00:00.000Z")).toBe("too-late");
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenCalledWith(EVENT_ID, DAY_BEFORE_LATER);
    expect(telemetry.counts.get("ReminderScheduled")).toBe(1);
  });
});

describe("SendEventReminders", () => {
  const setup = async (attendees: string[]) => {
    const events = new InMemoryEventRepository();
    await events.create(anEvent());
    const publisher = new RecordingPublisher<EventReminder>();
    const telemetry = recordingTelemetry();
    const clock = fixedClock();
    const useCase = new SendEventReminders(
      events,
      { listAttendees: () => Promise.resolve(attendees) },
      publisher,
      telemetry,
      clock,
    );
    return { useCase, publisher, telemetry, clock };
  };

  it("fans out one reminder per attendee", async () => {
    const { useCase, publisher, telemetry } = await setup(["u1", "u2"]);

    expect(await useCase.execute(EVENT_ID)).toBe(2);
    expect(publisher.published).toEqual(
      ["u1", "u2"].map((userId) => ({
        type: "EventReminder",
        eventId: EVENT_ID,
        userId,
        eventTitle: "TypeScript Summit",
        eventStartsAt: LATER,
        occurredAt: NOW.toISOString(),
      })),
    );
    expect(telemetry.counts.get("RemindersSent")).toBe(2);
  });

  it("sends nothing for a missing or already started event", async () => {
    const { useCase, publisher, clock } = await setup(["u1"]);
    expect(await useCase.execute("missing")).toBe(0);
    clock.set(new Date(LATER));
    expect(await useCase.execute(EVENT_ID)).toBe(0);
    expect(publisher.published).toEqual([]);
  });

  it("throws when publishing fails so the scheduler retries", async () => {
    const { useCase, publisher } = await setup(["u1"]);
    publisher.failWith = new Error("bus down");
    await expect(useCase.execute(EVENT_ID)).rejects.toThrow("bus down");
  });

  it("validates the schedule input", async () => {
    const execute = vi.fn().mockResolvedValue(3);
    const handler = makeSendRemindersHandler({ execute } as unknown as SendEventReminders);
    expect(await handler({ eventId: EVENT_ID })).toEqual({ eventId: EVENT_ID, sent: 3 });
    await expect(handler({ eventId: "nope" })).rejects.toThrow();
  });
});

describe("reminder trigger", () => {
  const change = (kind: StreamChange["kind"], newImage?: Record<string, unknown>): StreamChange => ({
    id: "c1",
    kind,
    at: NOW.toISOString(),
    ...(newImage === undefined ? {} : { newImage }),
  });

  it("fires for a newly inserted event item only", () => {
    const item = { type: "Event", id: EVENT_ID, startsAt: LATER };
    expect(toNewEvent(change("INSERT", item))).toEqual({ eventId: EVENT_ID, startsAt: LATER });
    expect(toNewEvent(change("MODIFY", item))).toBeUndefined();
    expect(toNewEvent(change("INSERT", { ...item, type: "Booking" }))).toBeUndefined();
    expect(toNewEvent(change("INSERT", { ...item, startsAt: 1 }))).toBeUndefined();
    expect(toNewEvent(change("REMOVE"))).toBeUndefined();
  });
});

describe("EventBridgeReminderScheduler", () => {
  const target = {
    groupName: "bookings-reminders",
    functionArn: "arn:aws:lambda:eu-west-1:123456789012:function:SendReminders",
    roleArn: "arn:aws:iam::123456789012:role/SchedulerRole",
    deadLetterQueueArn: "arn:aws:sqs:eu-west-1:123456789012:RemindersDlq",
  };

  it("creates a one-time, self-deleting schedule and treats a name clash as already scheduled", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new ConflictException({ Message: "exists", message: "exists", $metadata: {} }))
      .mockRejectedValueOnce(new Error("throttled"));
    const scheduler = new EventBridgeReminderScheduler({ send } as unknown as SchedulerClient, target);
    const at = new Date("2030-01-31T18:00:00.123Z");

    expect(await scheduler.schedule(EVENT_ID, at)).toBe("scheduled");
    expect((send.mock.calls[0]?.[0] as { input: unknown } | undefined)?.input).toEqual({
      Name: `reminder-${EVENT_ID}`,
      GroupName: target.groupName,
      ScheduleExpression: "at(2030-01-31T18:00:00)",
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: "OFF" },
      ActionAfterCompletion: "DELETE",
      Target: {
        Arn: target.functionArn,
        RoleArn: target.roleArn,
        Input: JSON.stringify({ eventId: EVENT_ID }),
        RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 },
        DeadLetterConfig: { Arn: target.deadLetterQueueArn },
      },
    });
    expect(await scheduler.schedule(EVENT_ID, at)).toBe("exists");
    await expect(scheduler.schedule(EVENT_ID, at)).rejects.toThrow("throttled");
  });
});
