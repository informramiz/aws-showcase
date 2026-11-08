import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../../src/shared/errors.js";
import { handleHttp } from "../../../src/shared/http/handle.js";
import { json, noContent, toProblem } from "../../../src/shared/http/problem.js";
import { actorFrom, header, parseJsonBody, parsePageQuery, pathParam } from "../../../src/shared/http/request.js";
import { Role } from "../../../src/shared/actor.js";
import { silentLogger } from "../../support/fixtures.js";
import { httpEvent, parseBody } from "../../support/http.js";

describe("toProblem", () => {
  it.each([
    [new ValidationError("bad", { seats: ["too big"] }), 400],
    [new ForbiddenError("ORGANIZER_ONLY", "no"), 403],
    [new NotFoundError("EVENT_NOT_FOUND", "no"), 404],
    [new ConflictError("SOLD_OUT", "no"), 409],
    [new BusinessRuleError("EVENT_STARTED", "no"), 422],
  ])("maps %s to %i problem+json", (error, status) => {
    const res = toProblem(error);
    expect(res.statusCode).toBe(status);
    expect(res.headers).toEqual({ "content-type": "application/problem+json" });
    const body = parseBody(res);
    expect(body).toMatchObject({ status, code: error.code, detail: error.message });
    expect(body["type"]).toBe(
      `https://bookings-api.example.com/problems/${error.code.toLowerCase().replaceAll("_", "-")}`,
    );
  });

  it("includes field errors only when there are some", () => {
    expect(parseBody(toProblem(new ValidationError("bad", { seats: ["x"] })))["errors"]).toEqual({ seats: ["x"] });
    expect(parseBody(toProblem(new ValidationError("bad")))).not.toHaveProperty("errors");
  });

  it("hides unknown errors behind a generic 500", () => {
    const res = toProblem(new Error("db password is hunter2"));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("hunter2");
    expect(parseBody(res)).toMatchObject({ code: "INTERNAL", type: "about:blank" });
  });

  it("json and noContent build plain responses", () => {
    expect(json(200, { a: 1 })).toEqual({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    expect(noContent()).toEqual({ statusCode: 204 });
  });
});

describe("handleHttp", () => {
  it("logs app errors at info and bugs at error", async () => {
    const logger = silentLogger();
    const info = vi.spyOn(logger, "info");
    const error = vi.spyOn(logger, "error");

    const rejected = await handleHttp(logger, () => Promise.reject(new ConflictError("SOLD_OUT", "x")))(httpEvent());
    const crashed = await handleHttp(logger, () => Promise.reject(new Error("bug")))(httpEvent());

    expect(rejected.statusCode).toBe(409);
    expect(crashed.statusCode).toBe(500);
    expect(info).toHaveBeenCalledWith("Request rejected", { code: "SOLD_OUT", kind: "conflict" });
    expect(error).toHaveBeenCalledOnce();
  });
});

describe("request helpers", () => {
  const schema = z.strictObject({ seats: z.number().int().min(1) });

  it("parses a JSON body, base64 or not", () => {
    expect(parseJsonBody(httpEvent({ body: { seats: 2 } }), schema)).toEqual({ seats: 2 });
    expect(parseJsonBody(httpEvent({ body: { seats: 2 }, base64: true }), schema)).toEqual({ seats: 2 });
  });

  it.each([
    ["a missing body", httpEvent(), "Request body is required"],
    ["malformed JSON", httpEvent({ rawBody: "{nope" }), "Request body must be valid JSON"],
  ])("rejects %s", (_name, event, message) => {
    expect(() => parseJsonBody(event, schema)).toThrow(message);
  });

  it("reports field errors by path, with _ for the root", () => {
    const fieldErrors = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as ValidationError).fieldErrors;
      }
      throw new Error("expected a ValidationError");
    };
    expect(fieldErrors(() => parseJsonBody(httpEvent({ body: { seats: 0 } }), schema))).toHaveProperty("seats");
    expect(fieldErrors(() => parseJsonBody(httpEvent({ body: [] }), schema))).toHaveProperty("_");
  });

  it("builds the actor from verified claims", () => {
    expect(actorFrom(httpEvent({ sub: "abc", groups: "[organizers]" }))).toEqual({
      userId: "abc",
      roles: new Set([Role.Organizer]),
    });
    expect(() => actorFrom(httpEvent({ sub: "" }))).toThrow("without a sub claim");
  });

  it("reads headers case-insensitively and requires path params", () => {
    const event = httpEvent({ headers: { "idempotency-key": "k" }, pathParameters: { eventId: "e" } });
    expect(header(event, "Idempotency-Key")).toBe("k");
    expect(pathParam(event, "eventId")).toBe("e");
    expect(() => pathParam(event, "bookingId")).toThrow("Missing path parameter bookingId");
  });

  it("parses paging with defaults and bounds", () => {
    expect(parsePageQuery(httpEvent())).toEqual({ limit: 20 });
    expect(parsePageQuery(httpEvent({ query: { limit: "5", cursor: "abc" } }))).toEqual({ limit: 5, cursor: "abc" });
    expect(() => parsePageQuery(httpEvent({ query: { limit: "500" } }))).toThrow(ValidationError);
  });
});
