/**
 * Typed application errors. Domain and application code throw these; only the HTTP edge maps them to
 * status codes (see `http/problem.ts`). Anything that is not an `AppError` is treated as a bug (500).
 */
export type FieldErrors = Readonly<Record<string, readonly string[]>>;

export abstract class AppError extends Error {
  abstract readonly kind: "validation" | "forbidden" | "not_found" | "conflict" | "business_rule";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The request is malformed: wrong shape, types or ranges. */
export class ValidationError extends AppError {
  readonly kind = "validation";

  constructor(
    message: string,
    readonly fieldErrors: FieldErrors = {},
  ) {
    super("VALIDATION_FAILED", message);
  }
}

/** The caller is authenticated but not allowed to do this. */
export class ForbiddenError extends AppError {
  readonly kind = "forbidden";
}

/** The resource does not exist, or the caller may not know that it exists. */
export class NotFoundError extends AppError {
  readonly kind = "not_found";
}

/** The request is valid but clashes with the current state (sold out, already booked, retry in flight). */
export class ConflictError extends AppError {
  readonly kind = "conflict";
}

/** The request is well-formed but breaks a domain rule (event in the past, event already started). */
export class BusinessRuleError extends AppError {
  readonly kind = "business_rule";
}
