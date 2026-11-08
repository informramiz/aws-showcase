import { type Stack, Validations } from "aws-cdk-lib";
import type { CfnTable, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import type { Bucket, CfnBucket } from "aws-cdk-lib/aws-s3";

export interface NagTargets {
  readonly table: TableV2;
  readonly bucket: Bucket;
}

/**
 * Every cdk-nag finding that is accepted on purpose, with the reason. Each one names the exact finding
 * (for IAM5, the exact resource), so a new wildcard or a new rule still fails synth until it is
 * fixed or justified in review.
 */
export const applyNagSuppressions = (stack: Stack, { table, bucket }: NagTargets): void => {
  const tableLogicalId = stack.getLogicalId(table.node.defaultChild as CfnTable);
  const bucketLogicalId = stack.getLogicalId(bucket.node.defaultChild as CfnBucket);
  const acks = [
    {
      id: "AwsSolutions-IAM5[Resource::*]",
      reason:
        "Only X-Ray xray:PutTraceSegments/PutTelemetryRecords (added by Tracing.ACTIVE) use *. X-Ray does not support resource-level permissions for them.",
    },
    {
      id: `AwsSolutions-IAM5[Resource::<${tableLogicalId}.Arn>/index/*]`,
      reason:
        "CDK table grants also cover the table's own indexes (table-arn/index/*) so Query on GSI1 works. Scoped to this one table.",
    },
    {
      id: `AwsSolutions-IAM5[Resource::<${bucketLogicalId}.Arn>/events/*]`,
      reason:
        "Image functions act on objects whose keys are generated per upload (events/<eventId>/<uploadId>.<ext>), so they need the events/ prefix. Scoped to that prefix of this one bucket.",
    },
    {
      id: "AwsSolutions-S1",
      reason:
        "Server access logs would need a second bucket and add cost for a demo; CloudTrail data events are the production choice for auditing object access.",
    },
    {
      id: "AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]",
      reason:
        "Only the CDK-managed BucketNotificationsHandler (a deploy-time custom resource that wires the S3 notification) uses the AWS managed basic execution policy; app functions use their own scoped roles.",
    },
    {
      id: "AwsSolutions-COG2",
      reason:
        "Demo API: required MFA would block the scripted sign-in in the README. A production pool should set mfa: Mfa.REQUIRED.",
    },
    {
      id: "AwsSolutions-COG8",
      reason:
        "Threat protection needs the paid Plus feature plan; left on Essentials to keep the demo free of fixed monthly cost.",
    },
  ];
  for (const ack of acks) Validations.of(stack).acknowledge(ack);
};
