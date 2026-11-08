import type { RemovalPolicy } from "aws-cdk-lib";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import type { HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpApi, LogGroupLogDestination } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { UserPool, UserPoolClient } from "aws-cdk-lib/aws-cognito";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export interface ApiRoute {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: IFunction;
}

export interface ApiProps {
  readonly userPool: UserPool;
  readonly client: UserPoolClient;
  readonly routes: readonly ApiRoute[];
  readonly removalPolicy: RemovalPolicy;
  readonly throttle: { readonly rateLimit: number; readonly burstLimit: number };
}

/**
 * HTTP API with a Cognito JWT authorizer on every route, stage throttling and JSON access logs.
 * API Gateway validates the token (signature, issuer, audience/client_id, expiry) before Lambda runs.
 */
export class Api extends Construct {
  readonly httpApi: HttpApi;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    const authorizer = new HttpUserPoolAuthorizer("CognitoAuthorizer", props.userPool, {
      userPoolClients: [props.client],
    });

    this.httpApi = new HttpApi(this, "HttpApi", {
      createDefaultStage: false,
      defaultAuthorizer: authorizer,
    });

    const accessLogs = new LogGroup(this, "AccessLogs", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy,
    });

    this.httpApi.addStage("DefaultStage", {
      stageName: "$default",
      autoDeploy: true,
      throttle: props.throttle,
      accessLogSettings: {
        destination: new LogGroupLogDestination(accessLogs),
        format: AccessLogFormat.custom(
          JSON.stringify({
            requestId: "$context.requestId",
            routeKey: "$context.routeKey",
            status: "$context.status",
            sub: "$context.authorizer.claims.sub",
            ip: "$context.identity.sourceIp",
            latencyMs: "$context.responseLatency",
            integrationError: "$context.integrationErrorMessage",
            authorizerError: "$context.authorizer.error",
          }),
        ),
      },
    });

    for (const route of props.routes) {
      this.httpApi.addRoutes({
        path: route.path,
        methods: [route.method],
        integration: new HttpLambdaIntegration(`${route.method}${route.path}`, route.handler),
      });
    }
  }
}
