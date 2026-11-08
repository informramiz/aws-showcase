import { ExecutionAlreadyExists, type SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type { SeatRelease, SeatReleaseWorkflow } from "../domain/seat-release-workflow.js";

/**
 * Starts the Standard workflow with the booking id as the execution name. Names are unique per state
 * machine for 90 days, so a redelivered stream record cannot start a second run: Step Functions
 * returns the running execution for the same name and input, or `ExecutionAlreadyExists` once it has
 * finished. https://docs.aws.amazon.com/step-functions/latest/apireference/API_StartExecution.html
 */
export class StepFunctionsSeatRelease implements SeatReleaseWorkflow {
  constructor(
    private readonly client: SFNClient,
    private readonly stateMachineArn: string,
  ) {}

  async start(release: SeatRelease): Promise<"started" | "duplicate"> {
    try {
      await this.client.send(
        new StartExecutionCommand({
          stateMachineArn: this.stateMachineArn,
          name: `release-${release.bookingId}`,
          input: JSON.stringify({ eventId: release.eventId, seats: release.seats }),
        }),
      );
      return "started";
    } catch (error) {
      if (error instanceof ExecutionAlreadyExists) return "duplicate";
      throw error;
    }
  }
}
