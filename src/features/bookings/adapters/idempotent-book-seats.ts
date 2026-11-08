import {
  IdempotencyAlreadyInProgressError,
  IdempotencyConfig,
  IdempotencyValidationError,
  makeIdempotent,
} from "@aws-lambda-powertools/idempotency";
import type { BasePersistenceLayer } from "@aws-lambda-powertools/idempotency/persistence";
import { BusinessRuleError, ConflictError } from "../../../shared/errors.js";
import type { Actor, Role } from "../../../shared/actor.js";
import type { BookSeats, BookSeatsCommand } from "../application/book-seats.js";
import type { Booking } from "../domain/booking.js";

/** What the HTTP handler calls: the use case keyed by the caller's `Idempotency-Key`. */
export type BookSeatsOnce = (actor: Actor, idempotencyKey: string, command: BookSeatsCommand) => Promise<Booking>;

interface IdempotentPayload {
  readonly userId: string;
  readonly roles: readonly Role[];
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly seats: number;
}

export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * Wraps `BookSeats` with Powertools idempotency. The key is the user plus their `Idempotency-Key`, so
 * two users can never collide. A retry with the same key gets the stored booking back without
 * booking again. A retry with the same key but a different body is rejected (422). A retry while the
 * first call is still running gets 409. Failed calls are not stored, so a retry after SOLD_OUT runs again.
 */
export const makeIdempotentBookSeats = (
  bookSeats: BookSeats,
  persistenceStore: BasePersistenceLayer,
  config: IdempotencyConfig = createIdempotencyConfig(),
): BookSeatsOnce => {
  const once = makeIdempotent(
    (payload: IdempotentPayload): Promise<Booking> =>
      bookSeats.execute(
        { userId: payload.userId, roles: new Set(payload.roles) },
        { eventId: payload.eventId, seats: payload.seats },
      ),
    { persistenceStore, config },
  );

  return async (actor, idempotencyKey, command) => {
    try {
      return await once({ userId: actor.userId, roles: [...actor.roles], idempotencyKey, ...command });
    } catch (error) {
      if (error instanceof IdempotencyValidationError) {
        throw new BusinessRuleError(
          "IDEMPOTENCY_KEY_REUSED",
          "This Idempotency-Key was already used with a different request body",
        );
      }
      if (error instanceof IdempotencyAlreadyInProgressError) {
        throw new ConflictError("REQUEST_IN_PROGRESS", "A request with this Idempotency-Key is still in progress");
      }
      throw error;
    }
  };
};

export const createIdempotencyConfig = (): IdempotencyConfig =>
  new IdempotencyConfig({
    eventKeyJmesPath: "[userId, idempotencyKey]",
    payloadValidationJmesPath: "[eventId, seats]",
    throwOnNoIdempotencyKey: true,
    expiresAfterSeconds: IDEMPOTENCY_TTL_SECONDS,
  });
