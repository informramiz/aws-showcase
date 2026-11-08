import type { HttpEvent } from "../../src/shared/http/request.js";

export interface HttpEventInit {
  readonly method?: string;
  readonly path?: string;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly base64?: boolean;
  readonly headers?: Record<string, string>;
  readonly pathParameters?: Record<string, string>;
  readonly query?: Record<string, string>;
  readonly sub?: string;
  readonly groups?: string;
}

/** Builds an API Gateway HTTP API (payload v2) event as the JWT authorizer delivers it. */
export const httpEvent = (init: HttpEventInit = {}): HttpEvent => {
  const raw = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  const body = raw !== undefined && init.base64 === true ? Buffer.from(raw).toString("base64") : raw;
  const claims: Record<string, string> = { sub: init.sub ?? "user-1" };
  if (init.groups !== undefined) claims["cognito:groups"] = init.groups;
  return {
    version: "2.0",
    routeKey: `${init.method ?? "GET"} ${init.path ?? "/"}`,
    rawPath: init.path ?? "/",
    rawQueryString: "",
    headers: init.headers ?? {},
    ...(init.query === undefined ? {} : { queryStringParameters: init.query }),
    ...(init.pathParameters === undefined ? {} : { pathParameters: init.pathParameters }),
    ...(body === undefined ? {} : { body }),
    isBase64Encoded: init.base64 === true,
    requestContext: {
      accountId: "123456789012",
      apiId: "api",
      domainName: "api.example.com",
      domainPrefix: "api",
      http: {
        method: init.method ?? "GET",
        path: init.path ?? "/",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "req-1",
      routeKey: `${init.method ?? "GET"} ${init.path ?? "/"}`,
      stage: "$default",
      time: "01/Jan/2030:12:00:00 +0000",
      timeEpoch: 1893499200000,
      authorizer: { principalId: "", integrationLatency: 0, jwt: { claims, scopes: [] } },
    },
  };
};

export const parseBody = (result: { body?: string | undefined }): Record<string, unknown> =>
  JSON.parse(result.body ?? "{}") as Record<string, unknown>;
