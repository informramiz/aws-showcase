import type { Clock } from "../../../shared/clock.js";
import { publishSafely } from "../../../shared/events/publish-safely.js";
import type { Telemetry } from "../../../shared/telemetry.js";
import type { OfferResult, WaitlistEventPublisher } from "../domain/waitlist.js";
import type { WaitlistRepository } from "../domain/waitlist-repository.js";

/** Workflow step: hold one freed seat for the next person in line and tell them about it. */
export class OfferNextSeat {
  constructor(
    private readonly waitlist: WaitlistRepository,
    private readonly publisher: WaitlistEventPublisher,
    private readonly telemetry: Telemetry,
    private readonly clock: Clock,
    private readonly holdSeconds: number,
  ) {}

  async execute(eventId: string): Promise<OfferResult> {
    const now = this.clock.now();
    const result = await this.waitlist.offerNext(eventId, now, new Date(now.getTime() + this.holdSeconds * 1000));
    if (!result.offered) return result;

    this.telemetry.count("WaitlistOfferMade");
    await publishSafely(this.publisher, this.telemetry, {
      type: "WaitlistSeatOffered",
      eventId,
      userId: result.userId,
      offerExpiresAt: result.offerExpiresAt,
      occurredAt: now.toISOString(),
    });
    return result;
  }
}
