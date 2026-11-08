import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { S3Event } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { DynamoDbEventRepository } from "../../../src/features/events/adapters/dynamodb-event-repository.js";
import { S3ImageStore, S3ImageUploadSigner } from "../../../src/features/events/adapters/s3-image-storage.js";
import { CreateImageUpload } from "../../../src/features/events/application/create-image-upload.js";
import { ProcessUploadedImage } from "../../../src/features/events/application/process-uploaded-image.js";
import {
  detectImageType,
  eventIdFromImageKey,
  imageKeyFor,
  MAX_IMAGE_BYTES,
} from "../../../src/features/events/domain/event-image.js";
import { makeCreateImageUploadHandler } from "../../../src/features/events/http/handlers.js";
import { decodeS3Key, makeImageUploadedHandler } from "../../../src/features/events/s3/image-uploaded.js";
import { InMemoryEventRepository, InMemoryImageStore, RecordingSigner } from "../../support/fakes.js";
import {
  anEvent,
  attendee,
  NOW,
  organizer,
  recordingTelemetry,
  sequentialIds,
  silentLogger,
} from "../../support/fixtures.js";
import { httpEvent, parseBody } from "../../support/http.js";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "00000000-0000-4000-8000-000000000001";
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Array<number>(12).fill(0)]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array<number>(8).fill(0)]);
const WEBP = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");

describe("event image rules", () => {
  it("recognises JPEG, PNG and WebP by magic bytes, not by name", () => {
    expect(detectImageType(JPEG)).toBe("image/jpeg");
    expect(detectImageType(PNG)).toBe("image/png");
    expect(detectImageType(WEBP)).toBe("image/webp");
    expect(detectImageType(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "))).toBeUndefined();
    expect(detectImageType(new TextEncoder().encode("<svg onload=x>"))).toBeUndefined();
    expect(detectImageType(new Uint8Array())).toBeUndefined();
  });

  it("builds keys under the event and reads the event id back only from keys it issued", () => {
    const key = imageKeyFor(EVENT_ID, UPLOAD_ID, "image/png");
    expect(key).toBe(`events/${EVENT_ID}/${UPLOAD_ID}.png`);
    expect(eventIdFromImageKey(key)).toBe(EVENT_ID);
    expect(eventIdFromImageKey(`events/${EVENT_ID}/../x.png`)).toBeUndefined();
    expect(eventIdFromImageKey(`events/${EVENT_ID}/${UPLOAD_ID}.svg`)).toBeUndefined();
    expect(eventIdFromImageKey("other/thing.png")).toBeUndefined();
  });
});

describe("CreateImageUpload", () => {
  const setup = () => {
    const events = new InMemoryEventRepository();
    events.events.set(EVENT_ID, anEvent());
    const signer = new RecordingSigner();
    return { signer, useCase: new CreateImageUpload(events, signer, sequentialIds()) };
  };

  it("signs a short-lived PUT bound to the key, type and exact size", async () => {
    const { signer, useCase } = setup();
    const upload = await useCase.execute(organizer(), EVENT_ID, { contentType: "image/png", contentLength: 1234 });

    expect(upload).toMatchObject({
      method: "PUT",
      key: `events/${EVENT_ID}/${UPLOAD_ID}.png`,
      headers: { "content-type": "image/png", "content-length": "1234" },
      expiresIn: 300,
    });
    expect(signer.requests).toEqual([
      { key: upload.key, contentType: "image/png", contentLength: 1234, expiresInSeconds: 300 },
    ]);
  });

  it("allows only the event's own organizer", async () => {
    const { useCase } = setup();
    const body = { contentType: "image/png", contentLength: 10 } as const;
    await expect(useCase.execute(organizer("org-2"), EVENT_ID, body)).rejects.toMatchObject({
      code: "NOT_EVENT_ORGANIZER",
    });
    await expect(useCase.execute(attendee("org-1"), EVENT_ID, body)).rejects.toMatchObject({ kind: "forbidden" });
    await expect(useCase.execute(organizer(), "missing", body)).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });
});

describe("POST /events/{eventId}/image-upload-url", () => {
  const handler = () => {
    const events = new InMemoryEventRepository();
    events.events.set(EVENT_ID, anEvent());
    return makeCreateImageUploadHandler({
      createImageUpload: new CreateImageUpload(events, new RecordingSigner(), sequentialIds()),
      logger: silentLogger(),
    });
  };
  const request = (body: unknown) =>
    httpEvent({ method: "POST", pathParameters: { eventId: EVENT_ID }, body, sub: "org-1", groups: "[organizers]" });

  it("returns 201 with the upload instructions", async () => {
    const res = await handler()(request({ contentType: "image/jpeg", contentLength: 2048 }));
    expect(res.statusCode).toBe(201);
    expect(parseBody(res)).toMatchObject({ method: "PUT", key: expect.stringMatching(/\.jpg$/) as string });
  });

  it("rejects other types and anything over 5 MiB", async () => {
    const svg = await handler()(request({ contentType: "image/svg+xml", contentLength: 10 }));
    const big = await handler()(request({ contentType: "image/png", contentLength: MAX_IMAGE_BYTES + 1 }));
    expect([svg.statusCode, big.statusCode]).toEqual([400, 400]);
  });
});

describe("ProcessUploadedImage", () => {
  const key = imageKeyFor(EVENT_ID, UPLOAD_ID, "image/jpeg");
  const setup = () => {
    const events = new InMemoryEventRepository();
    events.events.set(EVENT_ID, anEvent());
    const store = new InMemoryImageStore();
    const telemetry = recordingTelemetry();
    return { events, store, telemetry, useCase: new ProcessUploadedImage(events, store, telemetry) };
  };
  const at = NOW.toISOString();

  it("records a valid image on the event and deletes the one it replaces", async () => {
    const { events, store, telemetry, useCase } = setup();
    const oldKey = imageKeyFor(EVENT_ID, "00000000-0000-4000-8000-000000000009", "image/png");
    events.events.set(
      EVENT_ID,
      anEvent({ image: { key: oldKey, contentType: "image/png", size: 1, uploadedAt: "2029-12-31T00:00:00.000Z" } }),
    );
    store.objects.set(oldKey, PNG);
    store.objects.set(key, JPEG);

    expect(await useCase.execute({ key, size: 900, createdAt: at })).toBe("accepted");

    expect(events.events.get(EVENT_ID)?.image).toEqual({ key, contentType: "image/jpeg", size: 900, uploadedAt: at });
    expect([...store.objects.keys()]).toEqual([key]);
    expect(telemetry.counts.get("ImageAccepted")).toBe(1);
  });

  it("is safe to run twice for the same object", async () => {
    const { store, useCase } = setup();
    store.objects.set(key, JPEG);
    await useCase.execute({ key, size: 900, createdAt: at });
    expect(await useCase.execute({ key, size: 900, createdAt: at })).toBe("accepted");
    expect(store.objects.has(key)).toBe(true);
  });

  it.each([
    ["a non-image body", key, 10, new TextEncoder().encode("#!/bin/sh echo")],
    ["an oversized file", key, MAX_IMAGE_BYTES + 1, JPEG],
    ["a key the API never issued", "events/whatever.jpg", 10, JPEG],
  ])("deletes %s", async (_name, objectKey, size, bytes) => {
    const { events, store, telemetry, useCase } = setup();
    store.objects.set(objectKey, bytes);
    expect(await useCase.execute({ key: objectKey, size, createdAt: at })).toBe("rejected");
    expect(store.objects.size).toBe(0);
    expect(events.events.get(EVENT_ID)?.image).toBeUndefined();
    expect(telemetry.counts.get("ImageRejected")).toBe(1);
  });

  it("deletes an older upload that arrives after a newer one", async () => {
    const { events, store, useCase } = setup();
    const newer = {
      key: "events/x/newer.png",
      contentType: "image/png",
      size: 1,
      uploadedAt: "2031-01-01T00:00:00.000Z",
    } as const;
    events.events.set(EVENT_ID, anEvent({ image: newer }));
    store.objects.set(key, JPEG);
    expect(await useCase.execute({ key, size: 900, createdAt: at })).toBe("stale");
    expect(store.objects.has(key)).toBe(false);
    expect(events.events.get(EVENT_ID)?.image).toEqual(newer);
  });

  it("deletes an image for an event that no longer exists, and ignores objects already gone", async () => {
    const { events, store, useCase } = setup();
    events.events.clear();
    store.objects.set(key, JPEG);
    expect(await useCase.execute({ key, size: 900, createdAt: at })).toBe("orphaned");
    expect(store.objects.size).toBe(0);
    expect(await useCase.execute({ key, size: 900, createdAt: at })).toBe("missing");
  });
});

describe("S3 trigger", () => {
  it("decodes keys the way S3 encodes them in notifications", () => {
    expect(decodeS3Key("events/a+b/c%3D.png")).toBe("events/a b/c=.png");
  });

  it("hands every record to the use case", async () => {
    const execute = vi.fn().mockResolvedValue("accepted");
    const handler = makeImageUploadedHandler({ execute } as unknown as ProcessUploadedImage);
    const event = {
      Records: [{ eventTime: "2030-01-01T00:00:00.000Z", s3: { object: { key: "events/k%2B1.png", size: 5 } } }],
    } as unknown as S3Event;
    await handler(event);
    expect(execute).toHaveBeenCalledWith({ key: "events/k+1.png", size: 5, createdAt: "2030-01-01T00:00:00.000Z" });
  });
});

describe("S3 adapters", () => {
  const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };

  it("signs content-type and content-length into the URL (offline, no AWS call)", async () => {
    const signer = new S3ImageUploadSigner(new S3Client({ region: "eu-west-1", credentials }), "images");
    const url = new URL(
      await signer.presignPut({
        key: "events/e/u.png",
        contentType: "image/png",
        contentLength: 42,
        expiresInSeconds: 300,
      }),
    );
    expect(url.hostname).toBe("images.s3.eu-west-1.amazonaws.com");
    expect(url.pathname).toBe("/events/e/u.png");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(
      expect.arrayContaining(["content-length", "content-type", "host"]),
    );
  });

  it("reads only the header bytes and treats a missing object as gone", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Body: { transformToByteArray: () => Promise.resolve(JPEG) } })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new NoSuchKey({ message: "gone", $metadata: {} }))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({});
    const store = new S3ImageStore({ send } as unknown as S3Client, "images");

    expect(await store.readHeader("k", 16)).toEqual(JPEG);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ input: { Bucket: "images", Key: "k", Range: "bytes=0-15" } });
    expect(await store.readHeader("k", 16)).toEqual(new Uint8Array());
    expect(await store.readHeader("k", 16)).toBeUndefined();
    await expect(store.readHeader("k", 16)).rejects.toThrow("boom");
    await store.delete("k");
    expect(send.mock.calls[4]?.[0]).toMatchObject({ input: { Bucket: "images", Key: "k" } });
  });

  it("maps the conditional update outcomes when attaching an image", async () => {
    const image = { key: "k", contentType: "image/png", size: 1, uploadedAt: "2030-01-01T00:00:00.000Z" } as const;
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Attributes: { image: { ...image, key: "old" } } })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        new ConditionalCheckFailedException({ message: "x", $metadata: {}, Item: { PK: { S: "E" } } }),
      )
      .mockRejectedValueOnce(new ConditionalCheckFailedException({ message: "x", $metadata: {} }))
      .mockRejectedValueOnce(new Error("boom"));
    const repo = new DynamoDbEventRepository({ send } as unknown as DynamoDBDocumentClient, "table");

    expect(await repo.attachImage("e", image)).toEqual({ status: "attached", replaced: { ...image, key: "old" } });
    expect(await repo.attachImage("e", image)).toEqual({ status: "attached" });
    expect(await repo.attachImage("e", image)).toEqual({ status: "stale" });
    expect(await repo.attachImage("e", image)).toEqual({ status: "event_not_found" });
    await expect(repo.attachImage("e", image)).rejects.toThrow("boom");
  });
});
