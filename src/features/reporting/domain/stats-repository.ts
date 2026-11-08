import type { EventStats, StatsDelta } from "./event-stats.js";

/** `duplicate`: this change was already counted (stream records are delivered at least once). */
export type ApplyResult = "applied" | "duplicate";

export interface StatsRepository {
  /** Adds `delta` to the event's counters exactly once per `changeId`. */
  apply(changeId: string, eventId: string, delta: StatsDelta, at: string): Promise<ApplyResult>;
  get(eventId: string): Promise<EventStats | undefined>;
}
