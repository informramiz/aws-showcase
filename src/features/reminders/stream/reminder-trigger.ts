import type { StreamChange } from "../../../shared/dynamodb/stream.js";

/** A newly created event item: the moment to schedule its reminder. */
export const toNewEvent = (change: StreamChange): { eventId: string; startsAt: string } | undefined => {
  const item = change.newImage;
  if (change.kind !== "INSERT" || item?.["type"] !== "Event") return undefined;
  const { id, startsAt } = item;
  return typeof id === "string" && typeof startsAt === "string" ? { eventId: id, startsAt } : undefined;
};
