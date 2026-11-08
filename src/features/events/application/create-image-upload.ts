import type { Actor } from "../../../shared/actor.js";
import { NotFoundError } from "../../../shared/errors.js";
import type { IdGenerator } from "../../../shared/ids.js";
import { assertManagedBy } from "../domain/event.js";
import { type ImageContentType, imageKeyFor, UPLOAD_URL_TTL_SECONDS } from "../domain/event-image.js";
import type { EventRepository } from "../domain/event-repository.js";
import type { ImageUploadSigner } from "../domain/image-storage.js";

export interface CreateImageUploadCommand {
  readonly contentType: ImageContentType;
  readonly contentLength: number;
}

export interface ImageUpload {
  readonly uploadUrl: string;
  readonly method: "PUT";
  /** Headers the client must send unchanged: they are part of the signature. */
  readonly headers: Readonly<Record<string, string>>;
  readonly key: string;
  readonly expiresIn: number;
}

/**
 * Issues a presigned S3 PUT URL for an event image. The browser uploads straight to S3, so image bytes
 * never pass through Lambda or API Gateway (which caps payloads at 10 MB).
 */
export class CreateImageUpload {
  constructor(
    private readonly events: EventRepository,
    private readonly signer: ImageUploadSigner,
    private readonly ids: IdGenerator,
  ) {}

  async execute(actor: Actor, eventId: string, command: CreateImageUploadCommand): Promise<ImageUpload> {
    const event = await this.events.findById(eventId);
    if (event === undefined) throw new NotFoundError("EVENT_NOT_FOUND", "Event not found");
    assertManagedBy(event, actor);

    const key = imageKeyFor(eventId, this.ids.next(), command.contentType);
    const uploadUrl = await this.signer.presignPut({ key, ...command, expiresInSeconds: UPLOAD_URL_TTL_SECONDS });
    return {
      uploadUrl,
      method: "PUT",
      headers: { "content-type": command.contentType, "content-length": String(command.contentLength) },
      key,
      expiresIn: UPLOAD_URL_TTL_SECONDS,
    };
  }
}
