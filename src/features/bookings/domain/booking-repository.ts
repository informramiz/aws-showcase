import type { Page, PageRequest } from "../../../shared/page.js";
import type { Booking } from "./booking.js";

export interface BookingRepository {
  /**
   * Atomically takes `booking.seats` from the event and stores the booking. Throws `SOLD_OUT` when the
   * seats are gone, `ALREADY_BOOKED` when the user holds a booking, `EVENT_NOT_FOUND` when the event is gone.
   */
  confirm(booking: Booking): Promise<void>;
  /** Atomically marks the booking cancelled and returns its seats. Throws `ALREADY_CANCELLED` on a race. */
  cancel(booking: Booking): Promise<void>;
  findById(eventId: string, bookingId: string): Promise<Booking | undefined>;
  /** The user's bookings, newest first. */
  listByUser(userId: string, page: PageRequest): Promise<Page<Booking>>;
}
