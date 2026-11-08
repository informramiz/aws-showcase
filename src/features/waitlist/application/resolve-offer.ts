import type { Clock } from "../../../shared/clock.js";
import type { Telemetry } from "../../../shared/telemetry.js";
import type { OfferResolution } from "../domain/waitlist.js";
import type { WaitlistRepository } from "../domain/waitlist-repository.js";

/** Workflow step after the hold: keep an accepted seat, or expire the offer so the seat moves on. */
export class ResolveOffer {
  constructor(
    private readonly waitlist: WaitlistRepository,
    private readonly telemetry: Telemetry,
    private readonly clock: Clock,
  ) {}

  async execute(eventId: string, userId: string): Promise<OfferResolution> {
    const resolution = await this.waitlist.resolve(eventId, userId, this.clock.now());
    if (resolution === "expired") this.telemetry.count("WaitlistOfferExpired");
    return resolution;
  }
}
