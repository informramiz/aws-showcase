import { z } from "zod";
import { MAX_CAPACITY, type Event } from "../domain/event.js";
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_BYTES } from "../domain/event-image.js";

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
  image:
    event.image === undefined
      ? null
      : {
          key: event.image.key,
          contentType: event.image.contentType,
          size: event.image.size,
          uploadedAt: event.image.uploadedAt,
        },
});

/** The client states type and exact size up front; both are signed into the upload URL. */
export const imageUploadBody = z.strictObject({
  contentType: z.enum(IMAGE_CONTENT_TYPES),
  contentLength: z.number().int().min(1).max(MAX_IMAGE_BYTES),
});
