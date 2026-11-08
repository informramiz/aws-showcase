import { App, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { BookingsStack } from "../lib/bookings-stack.js";

const app = new App();

new BookingsStack(app, "BookingsApi", {
  // Environment-agnostic unless the CLI provides an account and region (cdk deploy --profile ...).
  ...(process.env["CDK_DEFAULT_ACCOUNT"] !== undefined && process.env["CDK_DEFAULT_REGION"] !== undefined
    ? { env: { account: process.env["CDK_DEFAULT_ACCOUNT"], region: process.env["CDK_DEFAULT_REGION"] } }
    : {}),
  description: "Bookings API showcase: HTTP API, Lambda, DynamoDB, Cognito, EventBridge, SQS",
});

// Fails synth on any AWS Solutions finding that is not acknowledged with a reason.
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
