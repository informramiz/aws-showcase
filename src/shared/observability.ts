import { Logger } from "@aws-lambda-powertools/logger";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { Metrics } from "@aws-lambda-powertools/metrics";
import { logMetrics } from "@aws-lambda-powertools/metrics/middleware";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { captureLambdaHandler } from "@aws-lambda-powertools/tracer/middleware";
import middy from "@middy/core";
import type { Context } from "aws-lambda";

export const METRICS_NAMESPACE = "BookingsApi";

/** Powertools logger, tracer and metrics for one function, created once per execution environment. */
export interface Observability {
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly metrics: Metrics;
}

export const createObservability = (serviceName: string): Observability => ({
  logger: new Logger({ serviceName }),
  tracer: new Tracer({ serviceName }),
  metrics: new Metrics({ namespace: METRICS_NAMESPACE, serviceName }),
});

/**
 * Wraps a handler with the Powertools Middy middlewares: a trace segment per invocation, the Lambda
 * context and cold-start flag on every log line, and metrics flushed in EMF format at the end.
 */
export const instrument = <TEvent, TResult>(
  handler: (event: TEvent, context: Context) => Promise<TResult>,
  { logger, tracer, metrics }: Observability,
) =>
  middy(handler)
    .use(captureLambdaHandler(tracer))
    .use(injectLambdaContext(logger, { resetKeys: true }))
    .use(logMetrics(metrics, { captureColdStartMetric: true }));
