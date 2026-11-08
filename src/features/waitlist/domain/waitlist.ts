/**
 * WAITING: in the queue. OFFERED: a held seat is reserved for this user until `offerExpiresAt`.
 * ACCEPTED: the user took the seat (a booking exists). EXPIRED: the hold ran out; the user may join again.
 */
export type WaitlistStatus = "WAITING" | "OFFERED" | "ACCEPTED" | "EXPIRED";
