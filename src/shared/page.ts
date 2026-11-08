/** One page of a cursor-paginated list. `nextCursor` is opaque to clients. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface PageRequest {
  readonly limit: number;
  readonly cursor?: string | undefined;
}
