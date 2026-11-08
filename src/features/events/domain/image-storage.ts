import type { ImageContentType } from "./event-image.js";

export interface UploadUrlRequest {
  readonly key: string;
  readonly contentType: ImageContentType;
  readonly contentLength: number;
  readonly expiresInSeconds: number;
}

/** Port: issues a presigned PUT URL bound to one key, content type and exact size. */
export interface ImageUploadSigner {
  presignPut(request: UploadUrlRequest): Promise<string>;
}

/** Port: reads and removes uploaded objects. */
export interface ImageStore {
  /** First bytes of the object, or undefined if it no longer exists. */
  readHeader(key: string, bytes: number): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
}
