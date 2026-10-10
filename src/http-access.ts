// @effect-diagnostics unstableApiUsage:off
import { createHash, timingSafeEqual } from "node:crypto";

import { Effect, Inspectable, Redacted, Schema, Stream } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import type { StartupConfig } from "./image-config.ts";
import {
  recordAccessRejection,
  withRequestLogging,
} from "./request-logging.ts";

class RequestBodyTooLarge extends Schema.TaggedError<RequestBodyTooLarge>()(
  "RequestBodyTooLarge",
  {},
) {}

const parseBearer = (authorization: string | undefined) =>
  authorization?.match(/^Bearer +([^\s]+)$/iu)?.[1];

const unusedBodyAccessor = new Error(
  "Bounded MCP requests must consume their body through text",
);

// Effect 4.0.2 has no request constructor/modify option for replacing a body
// while preserving source identity (used by legacy negotiation handlers).
// The MCP-reads-text invariant is enforced here: all other body accessors die
// rather than reading the already-consumed, unbounded source a second time.
class BoundedMcpRequest
  extends Inspectable.Class
  implements HttpServerRequest.HttpServerRequest
{
  readonly [HttpServerRequest.TypeId] = HttpServerRequest.TypeId;
  readonly [HttpIncomingMessage.TypeId] = HttpIncomingMessage.TypeId;
  readonly json = Effect.die(unusedBodyAccessor);
  readonly arrayBuffer = Effect.die(unusedBodyAccessor);
  readonly stream = Stream.die(unusedBodyAccessor);
  readonly urlParamsBody = Effect.die(unusedBodyAccessor);
  readonly multipart = Effect.die(unusedBodyAccessor);
  readonly multipartStream = Stream.die(unusedBodyAccessor);

  constructor(
    private readonly request: HttpServerRequest.HttpServerRequest,
    readonly text: Effect.Effect<string>,
  ) {
    super();
  }

  get source() {
    return this.request.source;
  }

  get url() {
    return this.request.url;
  }

  get originalUrl() {
    return this.request.originalUrl;
  }

  get method() {
    return this.request.method;
  }

  get headers() {
    return this.request.headers;
  }

  get remoteAddress() {
    return this.request.remoteAddress;
  }

  get cookies() {
    return this.request.cookies;
  }

  get upgrade() {
    return this.request.upgrade;
  }

  modify(
    options: Parameters<HttpServerRequest.HttpServerRequest["modify"]>[0],
  ): HttpServerRequest.HttpServerRequest {
    return new BoundedMcpRequest(this.request.modify(options), this.text);
  }

  toJSON() {
    return {
      _id: "HttpServerRequest",
      method: this.method,
      url: this.originalUrl,
    };
  }
}

const boundedRequest = (
  request: HttpServerRequest.HttpServerRequest,
  limit: number,
) =>
  Effect.gen(function* () {
    if (Number(request.headers["content-length"]) > limit) {
      return yield* new RequestBodyTooLarge();
    }

    let size = 0;

    const bytes = yield* request.stream.pipe(
      Stream.mapEffect(chunk => {
        size += chunk.byteLength;

        return size > limit
          ? Effect.fail(new RequestBodyTooLarge())
          : Effect.succeed(chunk);
      }),
      Stream.mkUint8Array,
    );

    return new BoundedMcpRequest(
      request,
      Effect.succeed(new TextDecoder().decode(bytes)),
    );
  });

export const accessMiddleware = (config: StartupConfig) => {
  const bearerToken = Redacted.value(config.bearerToken);
  const tokenDigest = createHash("sha256").update(bearerToken).digest();

  return HttpRouter.middleware(
    httpEffect =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        const suppliedToken = parseBearer(authorization);

        const suppliedDigest = createHash("sha256")
          .update(suppliedToken ?? "")
          .digest();

        const authenticated =
          suppliedToken !== undefined &&
          timingSafeEqual(tokenDigest, suppliedDigest);

        return yield* withRequestLogging(
          Effect.gen(function* () {
            if (request.headers.origin !== undefined) {
              yield* recordAccessRejection("origin_rejected");

              return HttpServerResponse.empty({ status: 403 });
            }

            if (!authenticated) {
              yield* recordAccessRejection("auth_rejected");

              return HttpServerResponse.empty({
                status: 401,
                headers: { "www-authenticate": "Bearer" },
              });
            }

            const limit = config.maxRequestBodyBytes;

            return yield* request.method !== "POST"
              ? httpEffect
              : boundedRequest(request, limit).pipe(
                  Effect.flatMap(bounded =>
                    Effect.provideService(
                      httpEffect,
                      HttpServerRequest.HttpServerRequest,
                      bounded,
                    ),
                  ),
                  Effect.catchTag("RequestBodyTooLarge", () =>
                    Effect.succeed(
                      HttpServerResponse.text(
                        `Request body exceeds ${limit} bytes.`,
                        { status: 413 },
                      ),
                    ),
                  ),
                );
          }),
          {
            tool:
              request.headers["mcp-name"] === "generate_image"
                ? "generate_image"
                : null,
            authentication: authenticated
              ? "authenticated"
              : authorization === undefined
                ? "missing"
                : "invalid",
            bearerToken,
            suppliedToken,
          },
        );
      }),
    { global: true },
  );
};
