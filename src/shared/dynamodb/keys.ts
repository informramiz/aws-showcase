/**
 * Single-table key design. Every access pattern is listed here so the table layout lives in one file.
 *
 * | Item     | PK              | SK                  | GSI1PK        | GSI1SK                       |
 * |----------|-----------------|---------------------|---------------|------------------------------|
 * | Event    | EVENT#<eventId> | META                | EVENTS        | <startsAt>#<eventId>         |
 * | Booking  | EVENT#<eventId> | BOOKING#<bookingId> | USER#<userId> | BOOKING#<createdAt>#<id>     |
 * | Attendee | EVENT#<eventId> | ATTENDEE#<userId>   | -             | -                            |
 *
 * The attendee item enforces "one active booking per user per event" with `attribute_not_exists`.
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
} as const;

export const GSI1 = "GSI1";
export const TABLE_KEY_ATTRS = ["PK", "SK"] as const;
export const GSI1_KEY_ATTRS = ["PK", "SK", "GSI1PK", "GSI1SK"] as const;
