import { z } from "zod";
import type { BookingEvent } from "../../bookings/domain/booking-events.js";
import type { Notifier } from "../domain/notifier.js";

/** The EventBridge envelope as it arrives in the SQS message body. Only the fields we use are checked. */
const envelopeSchema = z.object({
  "detail-type": z.enum(["BookingConfirmed", "BookingCancelled"]),
  detail: z.object({
    type: z.enum(["BookingConfirmed", "BookingCancelled"]),
    bookingId: z.string().min(1),
    eventId: z.string().min(1),
    userId: z.string().min(1),
    seats: z.number().int().positive(),
    occurredAt: z.iso.datetime({ offset: true }),
  }),
});

export const parseBookingEvent = (body: string): BookingEvent => envelopeSchema.parse(JSON.parse(body)).detail;

export class SendBookingNotification {
  constructor(private readonly notifier: Notifier) {}

  /** Throws on a malformed message so it is retried and then lands in the DLQ for inspection. */
  async execute(messageBody: string): Promise<void> {
    await this.notifier.notify(parseBookingEvent(messageBody));
  }
}
