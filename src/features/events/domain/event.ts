import { BusinessRuleError } from "../../../shared/errors.js";

export const MAX_CAPACITY = 10_000;

/** An event people can book seats for. `seatsRemaining` is the source of truth for availability. */
export interface Event {
  readonly id: string;
  readonly title: string;
  readonly venue: string;
  readonly startsAt: string;
  readonly capacity: number;
  readonly seatsRemaining: number;
  readonly organizerId: string;
  readonly createdAt: string;
}

export interface NewEventInput {
  readonly id: string;
  readonly title: string;
  readonly venue: string;
  readonly startsAt: Date;
  readonly capacity: number;
  readonly organizerId: string;
  readonly now: Date;
}

/** Creates a new event. Shape is validated at the edge; this enforces the time-dependent rule. */
export const createEvent = (input: NewEventInput): Event => {
  if (input.startsAt.getTime() <= input.now.getTime()) {
    throw new BusinessRuleError("EVENT_IN_PAST", "An event must start in the future");
  }
  return {
    id: input.id,
    title: input.title,
    venue: input.venue,
    startsAt: input.startsAt.toISOString(),
    capacity: input.capacity,
    seatsRemaining: input.capacity,
    organizerId: input.organizerId,
    createdAt: input.now.toISOString(),
  };
};

export const hasStarted = (event: Pick<Event, "startsAt">, now: Date): boolean =>
  Date.parse(event.startsAt) <= now.getTime();
