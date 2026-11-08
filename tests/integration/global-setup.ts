import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    dynamoEndpoint: string;
  }
}

const IMAGE = "amazon/dynamodb-local:3.3.2";
const PORT = 8000;

/** Starts one in-memory DynamoDB Local for the integration run and always stops it afterwards. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container: StartedTestContainer = await new GenericContainer(IMAGE)
    .withCommand(["-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb"])
    .withExposedPorts(PORT)
    .withWaitStrategy(Wait.forLogMessage(/Initializing DynamoDB Local/))
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(PORT)}`;
  await waitUntilServing(endpoint);
  project.provide("dynamoEndpoint", endpoint);
  return async () => {
    await container.stop();
  };
}

/** The log line appears before the HTTP listener is reachable through the VM port forward, so poll until it answers. */
const waitUntilServing = async (endpoint: string): Promise<void> => {
  const client = new DynamoDBClient({
    endpoint,
    region: "local",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    maxAttempts: 1,
  });
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await client.send(new ListTablesCommand({}));
        return;
      } catch (error) {
        if (attempt >= 50) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  } finally {
    client.destroy();
  }
};
