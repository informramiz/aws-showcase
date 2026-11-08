import { z } from "zod";
import { MAX_CAPACITY, type Event } from "../domain/event.js";

export const createEventBody = z.strictObject({
  title: z.string().trim().min(3).max(120),
  venue: z.string().trim().min(2).max(120),
  startsAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  capacity: z.number().int().min(1).max(MAX_CAPACITY),
});

export const eventIdParam = z.uuid();

/** Public representation. Kept separate from the domain type so storage fields never leak. */
export const toEventDto = (event: Event) => ({
  id: event.id,
  title: event.title,
  venue: event.venue,
  startsAt: event.startsAt,
  capacity: event.capacity,
  seatsRemaining: event.seatsRemaining,
  organizerId: event.organizerId,
  createdAt: event.createdAt,
});
