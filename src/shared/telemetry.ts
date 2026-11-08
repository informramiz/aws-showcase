import type { Logger } from "@aws-lambda-powertools/logger";
import { type Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";

/**
 * The slice of observability that use cases need. Keeping it a port means application code does not
 * import Powertools, and tests can assert on what was counted.
 */
export interface Telemetry {
  count(metric: string, value?: number): void;
  error(message: string, error: unknown, context?: Record<string, unknown>): void;
}

export const powertoolsTelemetry = (logger: Logger, metrics: Metrics): Telemetry => ({
  count: (metric, value = 1) => {
    metrics.addMetric(metric, MetricUnit.Count, value);
  },
  error: (message, error, context = {}) => {
    logger.error(message, { ...context, error: error instanceof Error ? error : String(error) });
  },
});
