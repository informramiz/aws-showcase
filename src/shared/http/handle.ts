import type { Logger } from "@aws-lambda-powertools/logger";
import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { AppError } from "../errors.js";
import { toProblem } from "./problem.js";
import type { HttpEvent } from "./request.js";

/**
 * Runs a route body and turns thrown errors into problem responses. Expected errors log at info,
 * anything else at error with the stack, so alarms fire on bugs and not on sold-out events.
 */
export const handleHttp =
  (logger: Logger, route: (event: HttpEvent) => Promise<APIGatewayProxyStructuredResultV2>) =>
  async (event: HttpEvent): Promise<APIGatewayProxyStructuredResultV2> => {
    try {
      return await route(event);
    } catch (error) {
      if (error instanceof AppError) {
        logger.info("Request rejected", { code: error.code, kind: error.kind });
      } else {
        logger.error("Unhandled error", error as Error);
      }
      return toProblem(error);
    }
  };
