import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { AppError, type FieldErrors } from "../errors.js";

/** RFC 9457 problem details body. */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly errors?: FieldErrors;
}

const STATUS_BY_KIND: Record<AppError["kind"], { status: number; title: string }> = {
  validation: { status: 400, title: "Bad Request" },
  forbidden: { status: 403, title: "Forbidden" },
  not_found: { status: 404, title: "Not Found" },
  conflict: { status: 409, title: "Conflict" },
  business_rule: { status: 422, title: "Unprocessable Content" },
};

const problemResponse = (problem: Problem): APIGatewayProxyStructuredResultV2 => ({
  statusCode: problem.status,
  headers: { "content-type": "application/problem+json" },
  body: JSON.stringify(problem),
});

export const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const noContent = (): APIGatewayProxyStructuredResultV2 => ({ statusCode: 204 });

/**
 * Maps an error to a problem response. Known `AppError`s keep their message; anything else becomes a
 * generic 500 so internals never leak to clients (the caller logs the original error).
 */
export const toProblem = (error: unknown): APIGatewayProxyStructuredResultV2 => {
  if (error instanceof AppError) {
    const { status, title } = STATUS_BY_KIND[error.kind];
    const errors = "fieldErrors" in error ? (error.fieldErrors as FieldErrors) : undefined;
    return problemResponse({
      type: `https://bookings-api.example.com/problems/${error.code.toLowerCase().replaceAll("_", "-")}`,
      title,
      status,
      code: error.code,
      detail: error.message,
      ...(errors !== undefined && Object.keys(errors).length > 0 ? { errors } : {}),
    });
  }
  return problemResponse({
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    code: "INTERNAL",
  });
};
