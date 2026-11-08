import type { RemovalPolicy } from "aws-cdk-lib";
import { Duration } from "aws-cdk-lib";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  Choice,
  Condition,
  DefinitionBody,
  JsonPath,
  LogLevel,
  Map,
  Pass,
  StateMachine,
  StateMachineType,
  Succeed,
  Wait,
  WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";

export interface WaitlistWorkflowProps {
  readonly offerSeat: IFunction;
  readonly resolveOffer: IFunction;
  readonly removalPolicy: RemovalPolicy;
}

/**
 * Seat-release workflow on a Standard state machine. Input `{eventId, seats}` (one cancelled booking).
 * For each freed seat, one at a time: offer it to the next person on the waitlist, wait out the hold,
 * then either finish (accepted) or offer it to the next person (expired).
 *
 * Standard, not Express: an execution waits out one hold per offer (15 minutes each, several in a row), Express stops at 5 minutes, and
 * Standard runs each state exactly once, so a seat is never offered twice by the engine itself.
 * https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html
 */
export class WaitlistWorkflow extends Construct {
  readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: WaitlistWorkflowProps) {
    super(scope, id);

    // Lambda's own retries for transient errors; a bad input or a bug fails the execution (visible in
    // the console and in the ExecutionsFailed metric) instead of looping.
    const offerSeat = new LambdaInvoke(this, "OfferSeat", {
      lambdaFunction: props.offerSeat,
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });
    const resolveOffer = new LambdaInvoke(this, "ResolveOffer", {
      lambdaFunction: props.resolveOffer,
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });
    const seatDone = new Succeed(this, "SeatDone");
    const holdSeat = new Wait(this, "HoldSeat", { time: WaitTime.secondsPath("$.holdSeconds") });

    const offerLoop = offerSeat.next(
      new Choice(this, "Offered?")
        .when(Condition.booleanEquals("$.offered", false), seatDone)
        .otherwise(
          holdSeat
            .next(resolveOffer)
            .next(
              new Choice(this, "Accepted?")
                .when(Condition.stringEquals("$.outcome", "expired"), offerSeat)
                .otherwise(seatDone),
            ),
        ),
    );

    // One iteration per freed seat, run in sequence so two offers never race for the same queue head.
    const perSeat = new Map(this, "EachFreedSeat", {
      itemsPath: "$.seatList",
      itemSelector: { "eventId.$": "$.eventId" },
      maxConcurrency: 1,
      resultPath: JsonPath.DISCARD,
    });
    perSeat.itemProcessor(offerLoop);

    const listSeats = new Pass(this, "ListFreedSeats", {
      parameters: {
        "eventId.$": "$.eventId",
        seatList: JsonPath.arrayRange(1, JsonPath.numberAt("$.seats"), 1),
      },
    });

    this.stateMachine = new StateMachine(this, "StateMachine", {
      stateMachineType: StateMachineType.STANDARD,
      definitionBody: DefinitionBody.fromChainable(listSeats.next(perSeat)),
      // Bounded: a waitlist with many expiries still ends; Standard allows up to a year.
      timeout: Duration.days(7),
      tracingEnabled: true,
      logs: {
        destination: new LogGroup(this, "Logs", {
          retention: RetentionDays.ONE_WEEK,
          removalPolicy: props.removalPolicy,
        }),
        level: LogLevel.ALL,
        includeExecutionData: false,
      },
    });
  }
}
