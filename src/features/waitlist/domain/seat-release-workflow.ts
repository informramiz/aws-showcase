/** What a cancellation hands to the waitlist: which event got seats back, how many, and why. */
export interface SeatRelease {
  readonly bookingId: string;
  readonly eventId: string;
  readonly seats: number;
}

/**
 * Port for the long-running workflow that offers released seats one by one. Starting it twice for the
 * same booking must not run it twice ("duplicate"), because the trigger is delivered at least once.
 */
export interface SeatReleaseWorkflow {
  start(release: SeatRelease): Promise<"started" | "duplicate">;
}
