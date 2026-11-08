import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/** Document client that drops `undefined` attributes so optional fields never reach DynamoDB. */
export const createDocumentClient = (client: DynamoDBClient = new DynamoDBClient({})): DynamoDBDocumentClient =>
  DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
