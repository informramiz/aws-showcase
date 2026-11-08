import { App, Validations } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { beforeAll, describe, expect, it } from "vitest";
import { BookingsStack } from "../../infra/lib/bookings-stack.js";

// Skip esbuild bundling: these tests are about the template, not the Lambda code.
const newApp = () => new App({ context: { "aws:cdk:bundling-stacks": [] } });

interface Statement {
  Action: string | string[];
}
interface Policy {
  Properties: { PolicyDocument: { Statement: Statement[] } };
}
interface Route {
  Properties: { RouteKey: string; AuthorizationType: string };
}

describe("BookingsStack", () => {
  let template: Template;

  beforeAll(() => {
    template = Template.fromStack(new BookingsStack(newApp(), "Test"));
  });

  it("runs every app function on Node 24 arm64 with X-Ray tracing", () => {
    // The only other function is CDK's own deploy-time handler that wires the S3 notification.
    const fns = Object.entries(template.findResources("AWS::Lambda::Function")).filter(
      ([id]) => !id.startsWith("BucketNotificationsHandler"),
    );
    expect(fns).toHaveLength(17);
    for (const [, fn] of fns) {
      expect(fn["Properties"]).toMatchObject({
        Runtime: "nodejs24.x",
        Architectures: ["arm64"],
        TracingConfig: { Mode: "Active" },
      });
    }
  });

  it("keeps all data in one table with a GSI, PITR and a TTL-backed idempotency table", () => {
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: "GSI1" })],
      Replicas: [Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })],
    });
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "expiration", Enabled: true },
    });
  });

  it("routes booking events from the bus to a queue with a dead-letter queue after 3 tries", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: Match.objectLike({ source: ["bookings-api"] }),
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
  });

  it("projects stats from the table stream with filters, bisecting retries and an on-failure queue", () => {
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      StreamSpecification: { StreamViewType: "NEW_AND_OLD_IMAGES" },
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      StartingPosition: "TRIM_HORIZON",
      BisectBatchOnFunctionError: true,
      MaximumRetryAttempts: 5,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      FilterCriteria: {
        Filters: [
          { Pattern: JSON.stringify({ dynamodb: { Keys: { SK: { S: [{ prefix: "BOOKING#" }] } } } }) },
          { Pattern: JSON.stringify({ dynamodb: { Keys: { SK: { S: [{ prefix: "WAITLIST#" }] } } } }) },
        ],
      },
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
  });

  it("runs the waitlist on a Standard state machine: one seat at a time, hold, then confirm or move on", () => {
    template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
      StateMachineType: "STANDARD",
      TracingConfiguration: { Enabled: true },
      LoggingConfiguration: Match.objectLike({ Level: "ALL" }),
    });
    const [machine] = Object.values(template.findResources("AWS::StepFunctions::StateMachine"));
    const definition = JSON.stringify(machine?.["Properties"]);
    expect(definition).toContain(String.raw`\"Type\":\"Map\"`);
    expect(definition).toContain(String.raw`\"MaxConcurrency\":1`);
    expect(definition).toContain(String.raw`States.ArrayRange(1, $.seats, 1)`);
    expect(definition).toContain(String.raw`\"SecondsPath\":\"$.holdSeconds\"`);
    expect(definition).toContain(String.raw`\"StringEquals\":\"expired\",\"Next\":\"OfferSeat\"`);
  });

  it("starts workflows from cancellations and new events on the second stream consumer", () => {
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      FilterCriteria: {
        Filters: [
          {
            Pattern: JSON.stringify({
              eventName: ["MODIFY"],
              dynamodb: {
                Keys: { SK: { S: [{ prefix: "BOOKING#" }] } },
                OldImage: { status: { S: ["CONFIRMED"] } },
                NewImage: { status: { S: ["CANCELLED"] } },
              },
            }),
          },
          { Pattern: JSON.stringify({ eventName: ["INSERT"], dynamodb: { Keys: { SK: { S: ["META"] } } } }) },
        ],
      },
    });
    expect(
      Object.keys(
        template.findResources("AWS::Lambda::EventSourceMapping", {
          Properties: { EventSourceArn: Match.anyValue(), StartingPosition: "TRIM_HORIZON" },
        }),
      ),
    ).toHaveLength(2);
  });

  it("schedules reminders in one group through a role only Scheduler in this account can assume", () => {
    template.hasResourceProperties("AWS::Scheduler::ScheduleGroup", { Name: "bookings-reminders" });
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: "scheduler.amazonaws.com" },
            Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } } },
          }),
        ],
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "scheduler:CreateSchedule",
            Resource: {
              "Fn::Join": ["", Match.arrayWith([":schedule/bookings-reminders/reminder-*"])],
            },
          }),
        ]),
      },
    });
  });

  it("keeps event images in a private, encrypted bucket that triggers validation on upload", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }),
          Match.objectLike({ Prefix: "events/", ExpirationInDays: 400 }),
        ]),
      },
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
        ]),
      },
    });
    template.hasResourceProperties("Custom::S3BucketNotifications", {
      NotificationConfiguration: {
        LambdaFunctionConfigurations: [
          Match.objectLike({
            Events: ["s3:ObjectCreated:*"],
            Filter: { Key: { FilterRules: [{ Name: "prefix", Value: "events/" }] } },
          }),
        ],
      },
    });
  });

  it("protects every route with the Cognito JWT authorizer", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", { AuthorizerType: "JWT" });
    const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route") as Record<string, Route>);
    expect(routes.map((r) => r.Properties.RouteKey).sort()).toEqual([
      "DELETE /events/{eventId}/bookings/{bookingId}",
      "GET /events",
      "GET /events/{eventId}",
      "GET /events/{eventId}/stats",
      "GET /me/bookings",
      "POST /events",
      "POST /events/{eventId}/bookings",
      "POST /events/{eventId}/image-upload-url",
      "POST /events/{eventId}/waitlist",
      "POST /events/{eventId}/waitlist/accept",
    ]);
    for (const route of routes) expect(route.Properties.AuthorizationType).toBe("JWT");
  });

  it("grants DynamoDB actions per function instead of wildcards", () => {
    const actions = Object.values(template.findResources("AWS::IAM::Policy") as Record<string, Policy>)
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions.filter((a) => a.startsWith("dynamodb:"))).not.toContain("dynamodb:*");
    expect(actions).not.toContain("dynamodb:Scan");
    expect(actions).not.toContain("*");
  });

  it("matches the reviewed template snapshot", () => {
    const json = JSON.stringify(template.toJSON(), null, 2)
      .replace(/[0-9a-f]{64}(\.zip|\.json)?/g, "<asset-hash>$1")
      .replace(/"S3Bucket": \{[^}]*\}/g, '"S3Bucket": "<bucket>"');
    expect(json).toMatchSnapshot();
  });
});

describe("cdk-nag AwsSolutions", () => {
  it("reports no unacknowledged findings", () => {
    const app = newApp();
    const stack = new BookingsStack(app, "Nag");
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    // Validation failures make synth throw; a clean run returns the assembly.
    expect(() => app.synth()).not.toThrow();
    const errors = Annotations.fromStack(stack).findError("*", Match.stringLikeRegexp("AwsSolutions-"));
    expect(errors).toEqual([]);
  });
});
