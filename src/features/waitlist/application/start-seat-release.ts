import type { Telemetry } from "../../../shared/telemetry.js";
import type { SeatRelease, SeatReleaseWorkflow } from "../domain/seat-release-workflow.js";

/** A confirmed booking was cancelled: start offering its seats to the waitlist (once per booking). */
export class StartSeatRelease {
  constructor(
    private readonly workflow: SeatReleaseWorkflow,
    private readonly telemetry: Telemetry,
  ) {}

  async execute(release: SeatRelease): Promise<void> {
    const outcome = await this.workflow.start(release);
    this.telemetry.count(outcome === "started" ? "SeatReleaseStarted" : "SeatReleaseDuplicate");
  }
}
