import type { Actor } from "../../../shared/actor.js";
import type { Page, PageRequest } from "../../../shared/page.js";
import type { Booking } from "../domain/booking.js";
import type { BookingRepository } from "../domain/booking-repository.js";

export class ListMyBookings {
  constructor(private readonly bookings: BookingRepository) {}

  execute(actor: Actor, page: PageRequest): Promise<Page<Booking>> {
    return this.bookings.listByUser(actor.userId, page);
  }
}
