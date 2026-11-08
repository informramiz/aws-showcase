import type { Telemetry } from "../../../shared/telemetry.js";
import { detectImageType, eventIdFromImageKey, IMAGE_HEADER_BYTES, MAX_IMAGE_BYTES } from "../domain/event-image.js";
import type { EventRepository } from "../domain/event-repository.js";
import type { ImageStore } from "../domain/image-storage.js";

export interface UploadedObject {
  readonly key: string;
  readonly size: number;
  /** When S3 created the object; orders competing uploads for the same event. */
  readonly createdAt: string;
}

/**
 * `missing`: the object is already gone (a redelivered S3 event after a newer upload replaced it).
 * S3 delivers events at least once, so every branch is safe to repeat.
 */
export type ImageOutcome = "accepted" | "rejected" | "stale" | "orphaned" | "missing";

const OUTCOME_METRICS: Record<ImageOutcome, string> = {
  accepted: "ImageAccepted",
  rejected: "ImageRejected",
  stale: "ImageStale",
  orphaned: "ImageOrphaned",
  missing: "ImageMissing",
};

/**
 * Runs on every S3 ObjectCreated event under `events/`. Keeps the object only if it is a real image of
 * an allowed format and size for an existing event; anything else is deleted so the bucket holds
 * nothing the API did not accept.
 */
export class ProcessUploadedImage {
  constructor(
    private readonly events: EventRepository,
    private readonly store: ImageStore,
    private readonly telemetry: Telemetry,
  ) {}

  async execute(object: UploadedObject): Promise<ImageOutcome> {
    const outcome = await this.process(object);
    this.telemetry.count(OUTCOME_METRICS[outcome]);
    return outcome;
  }

  private async process({ key, size, createdAt }: UploadedObject): Promise<ImageOutcome> {
    const eventId = eventIdFromImageKey(key);
    let contentType: ReturnType<typeof detectImageType>;
    if (eventId !== undefined && size <= MAX_IMAGE_BYTES) {
      const header = await this.store.readHeader(key, IMAGE_HEADER_BYTES);
      if (header === undefined) return "missing";
      contentType = detectImageType(header);
    }
    if (eventId === undefined || contentType === undefined) {
      await this.store.delete(key);
      return "rejected";
    }

    const result = await this.events.attachImage(eventId, { key, contentType, size, uploadedAt: createdAt });
    if (result.status === "stale") {
      await this.store.delete(key);
      return "stale";
    }
    if (result.status === "event_not_found") {
      await this.store.delete(key);
      return "orphaned";
    }
    if (result.replaced !== undefined && result.replaced.key !== key) await this.store.delete(result.replaced.key);
    return "accepted";
  }
}
