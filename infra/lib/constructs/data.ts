import type { RemovalPolicy } from "aws-cdk-lib";
import { AttributeType, Billing, StreamViewType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export interface DataProps {
  readonly removalPolicy: RemovalPolicy;
}

/** The single application table plus the Powertools idempotency table. Both on-demand: no idle cost. */
export class Data extends Construct {
  readonly table: TableV2;
  readonly idempotencyTable: TableV2;

  constructor(scope: Construct, id: string, props: DataProps) {
    super(scope, id);

    this.table = new TableV2(this, "Table", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billing: Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: props.removalPolicy,
      // Change data capture for the read models (stats), the waitlist workflow and reminders. Old and
      // new images let consumers see status transitions, not just the latest state.
      dynamoStream: StreamViewType.NEW_AND_OLD_IMAGES,
      globalSecondaryIndexes: [
        {
          indexName: "GSI1",
          partitionKey: { name: "GSI1PK", type: AttributeType.STRING },
          sortKey: { name: "GSI1SK", type: AttributeType.STRING },
        },
      ],
    });

    // Separate table so short-lived idempotency records (TTL 24h) never mix with business data and
    // the booking function's write access to them stays narrow.
    this.idempotencyTable = new TableV2(this, "IdempotencyTable", {
      partitionKey: { name: "id", type: AttributeType.STRING },
      timeToLiveAttribute: "expiration",
      billing: Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: props.removalPolicy,
    });
  }
}
