/** Image formats an organizer may upload, with the file extension used in the object key. */
export const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

export type ImageContentType = keyof typeof IMAGE_TYPES;
export const IMAGE_CONTENT_TYPES = Object.keys(IMAGE_TYPES) as [ImageContentType, ...ImageContentType[]];

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Presigned URLs are short-lived: long enough for one upload, too short to share around. */
export const UPLOAD_URL_TTL_SECONDS = 300;
/** Bytes read from the start of an object to recognise its format. */
export const IMAGE_HEADER_BYTES = 16;
export const IMAGE_KEY_PREFIX = "events/";

/** The image recorded on an event once the upload passed validation. */
export interface EventImage {
  readonly key: string;
  readonly contentType: ImageContentType;
  readonly size: number;
  readonly uploadedAt: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY_PATTERN = new RegExp(`^${IMAGE_KEY_PREFIX}(${UUID})/${UUID}\\.(?:jpg|png|webp)$`);

/** `events/<eventId>/<uploadId>.<ext>`: the event id in the key is how the S3 trigger finds the event. */
export const imageKeyFor = (eventId: string, uploadId: string, contentType: ImageContentType): string =>
  `${IMAGE_KEY_PREFIX}${eventId}/${uploadId}.${IMAGE_TYPES[contentType]}`;

/** Returns the event id for a key this API issued, or undefined for anything else in the bucket. */
export const eventIdFromImageKey = (key: string): string | undefined => KEY_PATTERN.exec(key)?.[1];

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  signature.every((b, i) => bytes[offset + i] === b);

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

/**
 * Recognises the format from the file's magic bytes. The Content-Type header is only what the client
 * claimed; the bytes are what the file is.
 */
export const detectImageType = (header: Uint8Array): ImageContentType | undefined => {
  if (startsWith(header, JPEG)) return "image/jpeg";
  if (startsWith(header, PNG)) return "image/png";
  if (startsWith(header, RIFF) && startsWith(header, WEBP, 8)) return "image/webp";
  return undefined;
};
