import type { RemovalPolicy } from "aws-cdk-lib";
import { Duration } from "aws-cdk-lib";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, LoggingFormat, Runtime, Tracing } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface AppFunctionProps {
  /** File name under `src/functions`, without extension. */
  readonly entry: string;
  readonly serviceName: string;
  readonly environment?: Record<string, string>;
  readonly timeout?: Duration;
  readonly removalPolicy: RemovalPolicy;
}

/**
 * One NodejsFunction with the project defaults: Node.js 24 on Graviton (arm64), X-Ray tracing, JSON
 * logs into a log group with a fixed retention, and an ESM bundle built by esbuild.
 */
export class AppFunction extends Construct {
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: AppFunctionProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, "Logs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy,
    });

    // Own role instead of the AWSLambdaBasicExecutionRole managed policy: log writes are scoped to
    // this function's log group only.
    const role = new Role(this, "Role", { assumedBy: new ServicePrincipal("lambda.amazonaws.com") });
    logGroup.grantWrite(role);

    this.fn = new NodejsFunction(this, "Fn", {
      role,
      entry: `${ROOT}src/functions/${props.entry}.ts`,
      projectRoot: ROOT,
      depsLockFilePath: `${ROOT}package-lock.json`,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: props.timeout ?? Duration.seconds(10),
      tracing: Tracing.ACTIVE,
      loggingFormat: LoggingFormat.JSON,
      logGroup,
      environment: {
        POWERTOOLS_SERVICE_NAME: props.serviceName,
        POWERTOOLS_METRICS_NAMESPACE: "BookingsApi",
        NODE_OPTIONS: "--enable-source-maps",
        ...props.environment,
      },
      bundling: {
        format: OutputFormat.ESM,
        target: "node24",
        minify: true,
        sourceMap: true,
        mainFields: ["module", "main"],
        // The AWS SDK is bundled (not taken from the runtime) so the deployed version matches the lockfile.
        externalModules: [],
        // Some CommonJS dependencies call require(); give the ESM bundle one.
        banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });
  }
}
