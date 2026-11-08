import { z } from "zod";
import { type Notification, NOTIFICATION_TYPES, type Notifier } from "../domain/notifier.js";

const id = z.string().min(1);
const timestamp = z.iso.datetime({ offset: true });

const bookingDetail = z.object({
  type: z.enum(["BookingConfirmed", "BookingCancelled"]),
  bookingId: id,
  eventId: id,
  userId: id,
  seats: z.number().int().positive(),
  occurredAt: timestamp,
});

const detailSchema = z.discriminatedUnion("type", [
  bookingDetail,
  z.object({
    type: z.literal("WaitlistSeatOffered"),
    eventId: id,
    userId: id,
    offerExpiresAt: timestamp,
    occurredAt: timestamp,
  }),
  z.object({
    type: z.literal("EventReminder"),
    eventId: id,
    userId: id,
    eventTitle: z.string().min(1),
    eventStartsAt: timestamp,
    occurredAt: timestamp,
  }),
]);

/** The EventBridge envelope as it arrives in the SQS message body. Only the fields we use are checked. */
const envelopeSchema = z.object({ "detail-type": z.enum(NOTIFICATION_TYPES), detail: detailSchema });

export const parseNotification = (body: string): Notification => envelopeSchema.parse(JSON.parse(body)).detail;

export class SendNotification {
  constructor(private readonly notifier: Notifier) {}

  /** Throws on a malformed message so it is retried and then lands in the DLQ for inspection. */
  async execute(messageBody: string): Promise<void> {
    await this.notifier.notify(parseNotification(messageBody));
  }
}
