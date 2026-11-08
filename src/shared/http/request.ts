import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { z } from "zod";
import { type Actor, rolesFromGroupsClaim } from "../actor.js";
import { ValidationError } from "../errors.js";

export type HttpEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

const toValidationError = (error: z.ZodError, message: string): ValidationError => {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "_";
    (fieldErrors[path] ??= []).push(issue.message);
  }
  return new ValidationError(message, fieldErrors);
};

/** Parses a value with a zod schema and turns failures into a 400 with per-field messages. */
export const parseWith = <S extends z.ZodType>(schema: S, value: unknown, message = "Invalid request"): z.output<S> => {
  const result = schema.safeParse(value);
  if (!result.success) throw toValidationError(result.error, message);
  return result.data;
};

/** Reads and validates a JSON body. API Gateway may base64-encode it. */
export const parseJsonBody = <S extends z.ZodType>(event: HttpEvent, schema: S): z.output<S> => {
  if (event.body === undefined || event.body === "") {
    throw new ValidationError("Request body is required");
  }
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
  return parseWith(schema, parsed, "Invalid request body");
};

/**
 * Builds the `Actor` from claims the API Gateway JWT authorizer already verified (signature, issuer,
 * audience, expiry). The function never sees an unauthenticated request because every route has the
 * authorizer attached.
 */
export const actorFrom = (event: HttpEvent): Actor => {
  const claims = event.requestContext.authorizer.jwt.claims;
  const sub = claims["sub"];
  if (typeof sub !== "string" || sub === "") {
    throw new Error("JWT authorizer passed a token without a sub claim");
  }
  return { userId: sub, roles: rolesFromGroupsClaim(claims["cognito:groups"]) };
};

/** Header lookup. HTTP API lower-cases header names. */
export const header = (event: HttpEvent, name: string): string | undefined => event.headers[name.toLowerCase()];

export const pathParam = (event: HttpEvent, name: string): string => {
  const value = event.pathParameters?.[name];
  if (value === undefined || value === "") throw new ValidationError(`Missing path parameter ${name}`);
  return value;
};

const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(2048).optional(),
});

export const parsePageQuery = (event: HttpEvent): z.output<typeof pageQuerySchema> =>
  parseWith(pageQuerySchema, event.queryStringParameters ?? {}, "Invalid query parameters");
