import type { Telemetry } from "../../../shared/telemetry.js";
import { deltaFor, isEmptyDelta, type TrackedChange } from "../domain/event-stats.js";
import type { StatsRepository } from "../domain/stats-repository.js";

export type ProjectionOutcome = "applied" | "duplicate" | "ignored";

/** Folds one tracked change into the event's stats (a CQRS read model fed by DynamoDB Streams). */
export class ProjectEventStats {
  constructor(
    private readonly stats: StatsRepository,
    private readonly telemetry: Telemetry,
  ) {}

  async execute(changeId: string, change: TrackedChange, at: string): Promise<ProjectionOutcome> {
    const delta = deltaFor(change);
    if (isEmptyDelta(delta)) return "ignored";
    const result = await this.stats.apply(changeId, change.eventId, delta, at);
    if (result === "duplicate") this.telemetry.count("StatsDuplicateChange");
    return result;
  }
}
