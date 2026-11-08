import { ValidationError } from "../errors.js";

type Key = Record<string, unknown>;

/** Encodes a DynamoDB `LastEvaluatedKey` as an opaque base64url cursor. */
export const encodeCursor = (key: Key | undefined): string | undefined =>
  key === undefined ? undefined : Buffer.from(JSON.stringify(key), "utf8").toString("base64url");

/**
 * Decodes a cursor back to an `ExclusiveStartKey`. Only string-valued keys are accepted, and the
 * caller passes the attribute names it expects, so a client cannot steer the query with a forged key.
 */
export const decodeCursor = (cursor: string | undefined, expectedKeys: readonly string[]): Key | undefined => {
  if (cursor === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ValidationError("Invalid cursor", { cursor: ["is not a valid cursor"] });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Object.keys(parsed).length !== expectedKeys.length ||
    !expectedKeys.every((k) => typeof (parsed as Key)[k] === "string")
  ) {
    throw new ValidationError("Invalid cursor", { cursor: ["is not a valid cursor"] });
  }
  return parsed as Key;
};
