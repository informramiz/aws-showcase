import { randomUUID } from "node:crypto";

/** ID source, injected so tests can produce predictable IDs. */
export interface IdGenerator {
  next(): string;
}

export const uuidGenerator: IdGenerator = { next: () => randomUUID() };
