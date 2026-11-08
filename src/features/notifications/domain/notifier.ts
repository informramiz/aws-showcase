import type { BookingEvent } from "../../bookings/domain/booking-events.js";

/** Port for sending a booking notification (email, push, ...). */
export interface Notifier {
  notify(event: BookingEvent): Promise<void>;
}
