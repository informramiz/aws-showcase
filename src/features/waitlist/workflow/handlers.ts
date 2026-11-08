import { z } from "zod";
import type { OfferNextSeat } from "../application/offer-next-seat.js";
import type { ResolveOffer } from "../application/resolve-offer.js";

const offerInput = z.object({ eventId: z.uuid() });
const resolveInput = z.object({ eventId: z.uuid(), userId: z.string().min(1) });

/**
 * Step Functions task: offer one freed seat. The output drives the state machine's Choice and Wait
 * states (`offered`, `userId`, `holdSeconds`). A bad input throws, which fails the execution loudly.
 */
export const makeOfferSeatTask = (useCase: OfferNextSeat, holdSeconds: number) => async (input: unknown) => {
  const { eventId } = offerInput.parse(input);
  const result = await useCase.execute(eventId);
  return result.offered ? { eventId, offered: true, userId: result.userId, holdSeconds } : { eventId, offered: false };
};

/** Step Functions task after the hold: `outcome` is "accepted" (done) or "expired" (offer again). */
export const makeResolveOfferTask = (useCase: ResolveOffer) => async (input: unknown) => {
  const { eventId, userId } = resolveInput.parse(input);
  return { eventId, outcome: await useCase.execute(eventId, userId) };
};
