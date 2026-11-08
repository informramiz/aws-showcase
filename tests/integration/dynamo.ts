import { randomUUID } from "node:crypto";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { inject } from "vitest";
import { createDocumentClient } from "../../src/shared/dynamodb/client.js";

/** Clients for the DynamoDB Local container. Credentials are dummies; Local accepts any. */
export const localClients = () => {
  const client = new DynamoDBClient({
    endpoint: inject("dynamoEndpoint"),
    region: "local",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  return { client, doc: createDocumentClient(client) };
};

/** Creates the application table with the same keys and GSI as `infra/lib/constructs/data.ts`. */
export const createAppTable = async (client: DynamoDBClient): Promise<string> => {
  const TableName = `app-${randomUUID()}`;
  await client.send(
    new CreateTableCommand({
      TableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: ["PK", "SK", "GSI1PK", "GSI1SK"].map((AttributeName) => ({
        AttributeName,
        AttributeType: "S",
      })),
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "GSI1PK", KeyType: "HASH" },
            { AttributeName: "GSI1SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );
  return TableName;
};

/** Creates a Powertools idempotency table (partition key `id`). */
export const createIdempotencyTable = async (client: DynamoDBClient): Promise<string> => {
  const TableName = `idem-${randomUUID()}`;
  await client.send(
    new CreateTableCommand({
      TableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    }),
  );
  return TableName;
};
