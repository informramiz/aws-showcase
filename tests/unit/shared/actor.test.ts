import { describe, expect, it } from "vitest";
import { hasRole, Role, rolesFromGroupsClaim } from "../../../src/shared/actor.js";

describe("rolesFromGroupsClaim", () => {
  it("reads the bracketed string form API Gateway passes", () => {
    expect(rolesFromGroupsClaim("[organizers attendees]")).toEqual(new Set([Role.Organizer, Role.Attendee]));
  });

  it("reads a real array and ignores unknown groups and non-strings", () => {
    expect(rolesFromGroupsClaim(["attendees", "admins", 7])).toEqual(new Set([Role.Attendee]));
  });

  it("returns no roles when the claim is missing", () => {
    expect(rolesFromGroupsClaim(undefined).size).toBe(0);
  });

  it("hasRole checks membership", () => {
    expect(hasRole({ userId: "u", roles: new Set([Role.Organizer]) }, Role.Organizer)).toBe(true);
    expect(hasRole({ userId: "u", roles: new Set() }, Role.Organizer)).toBe(false);
  });
});
