import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ImageStore, ImageUploadSigner, UploadUrlRequest } from "../domain/image-storage.js";

/**
 * Presigned PUT with `Content-Type` and `Content-Length` in the signed headers. A PUT URL does not
 * limit size by itself; signing the length means S3 rejects any body of a different size or type
 * (SignatureDoesNotMatch), so the limits checked by the API hold at upload time too.
 */
export class S3ImageUploadSigner implements ImageUploadSigner {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  presignPut({ key, contentType, contentLength, expiresInSeconds }: UploadUrlRequest): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: expiresInSeconds,
      signableHeaders: new Set(["content-type", "content-length"]),
    });
  }
}

export class S3ImageStore implements ImageStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async readHeader(key: string, bytes: number): Promise<Uint8Array | undefined> {
    try {
      // A ranged GET reads only the magic bytes, not the whole file.
      const { Body } = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }),
      );
      return Body === undefined ? new Uint8Array() : await Body.transformToByteArray();
    } catch (error) {
      if (error instanceof NoSuchKey) return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
