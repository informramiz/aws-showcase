/** Cognito groups that carry the two roles. Users are put in groups by an admin (self sign-up is off). */
export const Role = {
  Organizer: "organizers",
  Attendee: "attendees",
} as const;

export type Role = (typeof Role)[keyof typeof Role];

const ROLES: readonly string[] = Object.values(Role);

/** The authenticated caller, as the application layer sees it. Built from verified JWT claims only. */
export interface Actor {
  readonly userId: string;
  readonly roles: ReadonlySet<Role>;
}

export const hasRole = (actor: Actor, role: Role): boolean => actor.roles.has(role);

const isRole = (value: string): value is Role => ROLES.includes(value);

/**
 * Reads roles from the `cognito:groups` claim. API Gateway HTTP API JWT authorizers pass array claims
 * as one string like `"[organizers attendees]"`, so both that form and a real array are accepted.
 */
export const rolesFromGroupsClaim = (claim: unknown): ReadonlySet<Role> => {
  let groups: string[] = [];
  if (Array.isArray(claim)) {
    groups = claim.filter((g): g is string => typeof g === "string");
  } else if (typeof claim === "string") {
    groups = claim.replace(/^\[|\]$/g, "").split(/[\s,]+/);
  }
  return new Set(groups.map((g) => g.trim()).filter(isRole));
};
