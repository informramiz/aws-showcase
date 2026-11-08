/**
 * Single-table key design. Every access pattern is listed here so the table layout lives in one file.
 *
 * | Item     | PK              | SK                  | GSI1PK        | GSI1SK                       |
 * |----------|-----------------|---------------------|---------------|------------------------------|
 * | Event    | EVENT#<eventId> | META                | EVENTS        | <startsAt>#<eventId>         |
 * | Booking  | EVENT#<eventId> | BOOKING#<bookingId> | USER#<userId> | BOOKING#<createdAt>#<id>     |
 * | Attendee | EVENT#<eventId> | ATTENDEE#<userId>   | -             | -                            |
 * | Waitlist | EVENT#<eventId> | WAITLIST#<userId>   | WAITLIST#<eventId> | <joinedAt>#<userId>     |
 * | Stats    | EVENT#<eventId> | STATS               | -             | -                            |
 *
 * The attendee item enforces "one active booking per user per event" with `attribute_not_exists`.
 * A waitlist entry carries GSI1 keys only while it is WAITING (a sparse index), so "next in line" is
 * the first item of one GSI1 query and offered or finished entries drop out of the queue on their own.
 */
export const Keys = {
  event: (eventId: string) => ({ PK: `EVENT#${eventId}`, SK: "META" }),
  eventListing: (startsAt: string, eventId: string) => ({ GSI1PK: "EVENTS", GSI1SK: `${startsAt}#${eventId}` }),
  booking: (eventId: string, bookingId: string) => ({ PK: `EVENT#${eventId}`, SK: `BOOKING#${bookingId}` }),
  userBooking: (userId: string, createdAt: string, bookingId: string) => ({
    GSI1PK: `USER#${userId}`,
    GSI1SK: `BOOKING#${createdAt}#${bookingId}`,
  }),
  attendee: (eventId: string, userId: string) => ({ PK: `EVENT#${eventId}`, SK: `ATTENDEE#${userId}` }),
  waitlistEntry: (eventId: string, userId: string) => ({ PK: `EVENT#${eventId}`, SK: `WAITLIST#${userId}` }),
  waitlistQueue: (eventId: string, joinedAt: string, userId: string) => ({
    GSI1PK: `WAITLIST#${eventId}`,
    GSI1SK: `${joinedAt}#${userId}`,
  }),
  stats: (eventId: string) => ({ PK: `EVENT#${eventId}`, SK: "STATS" }),
} as const;

/** Sort-key prefixes, for queries and for stream event filters. */
export const SK_PREFIX = { booking: "BOOKING#", attendee: "ATTENDEE#", waitlist: "WAITLIST#" } as const;
export const EVENT_META_SK = "META";

export const GSI1 = "GSI1";
export const TABLE_KEY_ATTRS = ["PK", "SK"] as const;
export const GSI1_KEY_ATTRS = ["PK", "SK", "GSI1PK", "GSI1SK"] as const;
