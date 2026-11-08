/** Time source, injected so domain rules and tests never read the wall clock directly. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
