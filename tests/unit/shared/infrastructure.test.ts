import { describe, expect, it, vi } from "vitest";
import type { Context } from "aws-lambda";
import { requireEnv } from "../../../src/shared/config.js";
import { systemClock } from "../../../src/shared/clock.js";
import { uuidGenerator } from "../../../src/shared/ids.js";
import { decodeCursor, encodeCursor } from "../../../src/shared/dynamodb/cursor.js";
import { createDocumentClient } from "../../../src/shared/dynamodb/client.js";
import { ValidationError } from "../../../src/shared/errors.js";
import { createObservability, instrument } from "../../../src/shared/observability.js";
import { powertoolsTelemetry } from "../../../src/shared/telemetry.js";

describe("requireEnv", () => {
  it("returns a set variable", () => {
    expect(requireEnv("A", { A: "x" })).toBe("x");
  });

  it.each([undefined, ""])("fails fast on %j", (value) => {
    expect(() => requireEnv("A", { A: value })).toThrow("Missing required environment variable A");
  });
});

describe("cursor", () => {
  const keys = ["PK", "SK"] as const;

  it("round-trips a key", () => {
    const key = { PK: "EVENT#1", SK: "META" };
    expect(decodeCursor(encodeCursor(key), keys)).toEqual(key);
  });

  it("passes undefined through", () => {
    expect(encodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor(undefined, keys)).toBeUndefined();
  });

  it.each([
    ["not base64 json", "%%%"],
    ["wrong keys", encodeCursor({ PK: "a", other: "b" })],
    ["non-string values", encodeCursor({ PK: "a", SK: { S: "b" } })],
    ["extra keys", encodeCursor({ PK: "a", SK: "b", GSI1PK: "c" })],
    ["a non-object", Buffer.from("42").toString("base64url")],
  ])("rejects %s", (_name, cursor) => {
    expect(() => decodeCursor(cursor, keys)).toThrow(ValidationError);
  });
});

describe("defaults", () => {
  it("system clock and uuid generator produce real values", () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000);
    expect(uuidGenerator.next()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("document client drops undefined attributes", () => {
    const client = createDocumentClient();
    expect(client.config.translateConfig?.marshallOptions?.removeUndefinedValues).toBe(true);
  });
});

describe("observability", () => {
  it("telemetry adds count metrics and logs errors with context", () => {
    const obs = createObservability("test");
    const addMetric = vi.spyOn(obs.metrics, "addMetric");
    const error = vi.spyOn(obs.logger, "error");
    const telemetry = powertoolsTelemetry(obs.logger, obs.metrics);

    telemetry.count("BookingConfirmed");
    telemetry.count("SeatsBooked", 3);
    telemetry.error("boom", new Error("x"), { id: "1" });
    telemetry.error("boom", "plain");

    expect(addMetric).toHaveBeenCalledWith("BookingConfirmed", "Count", 1);
    expect(addMetric).toHaveBeenCalledWith("SeatsBooked", "Count", 3);
    expect(error).toHaveBeenCalledWith("boom", { id: "1", error: expect.any(Error) as Error });
    expect(error).toHaveBeenCalledWith("boom", { error: "plain" });
  });

  it("instrument runs the handler through the middleware chain", async () => {
    const obs = createObservability("test");
    const publish = vi.spyOn(obs.metrics, "publishStoredMetrics").mockReturnValue(obs.metrics);
    const handler = instrument((event: { n: number }) => Promise.resolve(event.n * 2), obs);
    const context = { functionName: "fn", awsRequestId: "req", getRemainingTimeInMillis: () => 1000 } as Context;

    await expect(handler({ n: 21 }, context)).resolves.toBe(42);
    expect(publish).toHaveBeenCalled();
  });
});
