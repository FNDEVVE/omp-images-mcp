// @effect-diagnostics unstableApiUsage:off
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";

import {
  Clock,
  ConfigProvider,
  Duration,
  Effect,
  Layer,
  Logger,
  Schema,
} from "effect";
import { HttpRouter } from "effect/http";

import { type StartupConfig, startupConfig } from "../src/image-config.ts";
import * as ImageService from "../src/image-service.ts";
import { readMcpResponse } from "./mcp-response.ts";

export const revisions = ["2026-07-28", "2025-11-25", "2025-06-18"];

const Envelope = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({ code: Schema.Number, message: Schema.String }),
  ),
});

export const makeHarnessWithConfig = (
  limits: Partial<
    Pick<
      StartupConfig,
      | "maxConcurrentExecutions"
      | "maxRequestBodyBytes"
      | "retention"
      | "retentionDirectory"
    >
  > = {},
  providers: ReadonlyArray<string> = ["openai"],
) =>
  Effect.gen(function* () {
    const logs: unknown[] = [];

    const logger = Logger.make(options => {
      logs.push(Logger.formatStructured.log(options));
    });

    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "omp-images-profile-"))),
      directory =>
        Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );

    const bearerTokenFile = join(directory, "bearer-token");

    yield* Effect.promise(() =>
      writeFile(bearerTokenFile, "test-bearer-token\n", { mode: 0o600 }),
    );

    yield* Effect.promise(() =>
      writeFile(
        join(directory, "config.yml"),
        "modelRoles:\n  default: openai/gpt-5.4\n  image: openai/gpt-image-2\n",
      ),
    );
    yield* Effect.promise(async () => {
      const settings = await Settings.loadReadOnly({
        agentDir: directory,
        cwd: directory,
      });

      const auth = await discoverAuthStorage(directory, {
        settings,
        cwd: directory,
      });

      try {
        for (const provider of providers) {
          await auth.credentials.set(provider, {
            type: "api_key",
            key: "fake-provider-key",
          });
        }
      } finally {
        auth.close();
      }
    });
    const providerRequests: Request[] = [];

    let providerResponse = Response.json({
      output: [
        {
          type: "image_generation_call",
          result: "AQID",
          size: "1536x1024",
          quality: "high",
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "Provider caption." }],
        },
      ],
      tools: [{ type: "image_generation", model: "fixture-image-model" }],
    });

    let pending:
      | {
          response: ReturnType<typeof Promise.withResolvers<Response>>;
          started: ReturnType<typeof Promise.withResolvers<void>>;
          aborted: ReturnType<typeof Promise.withResolvers<void>>;
        }
      | undefined;

    const clock = yield* Clock.Clock;

    const config = yield* startupConfig.parse(
      ConfigProvider.fromUnknown({
        ...limits,
        bearerTokenFile,
        profileDirectory: directory,
        workingDirectory: directory,
        retentionDirectory:
          limits.retentionDirectory ?? join(directory, "generated"),
        retention:
          limits.retention === undefined
            ? undefined
            : Duration.toMillis(limits.retention) + " millis",
      }),
    );

    const start = () =>
      HttpRouter.toWebHandler(
        ImageService.layer(config, (input, init) => {
          providerRequests.push(
            new Request(
              input instanceof Request ? input.url : String(input),
              init,
            ),
          );

          if (pending) {
            const gate = pending;
            pending = undefined;
            const signal = init?.signal;
            signal?.addEventListener(
              "abort",
              () => {
                gate.aborted.resolve();
                gate.response.reject(
                  new Error("Fake provider request aborted"),
                );
              },
              { once: true },
            );
            gate.started.resolve();

            return gate.response.promise;
          }

          return Promise.resolve(
            new Response(providerResponse.clone().body, {
              status: providerResponse.status,
              headers: providerResponse.headers,
            }),
          );
        }).pipe(
          Layer.provideMerge(Logger.layer([logger])),
          Layer.provideMerge(Layer.succeed(Clock.Clock)(clock)),
        ),
        { disableLogger: true },
      );

    let current = start();

    yield* Effect.addFinalizer(() => Effect.promise(() => current.dispose()));

    const request = (
      body: string | ReadableStream<Uint8Array>,
      headers: Headers,
      signal?: AbortSignal,
    ) =>
      Effect.promise(() =>
        current.handler(
          new Request("http://localhost/mcp", {
            method: "POST",
            headers,
            body,
            signal: signal ?? null,
          }),
        ),
      );

    const connect = (revision: string) =>
      Effect.gen(function* () {
        const headers = new Headers({
          Authorization: "Bearer test-bearer-token",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": revision,
        });

        let nextId = 1;

        const send = (
          method: string,
          params: Schema.Json = {},
          override?: Headers,
          signal?: AbortSignal,
        ) =>
          Effect.gen(function* () {
            const requestHeaders = new Headers(override ?? headers);
            const body = { jsonrpc: "2.0", id: nextId++, method, params };

            if (revision === "2026-07-28") {
              requestHeaders.set("Mcp-Method", method);

              if (method === "tools/call") {
                requestHeaders.set("Mcp-Name", "generate_image");
              }

              body.params = {
                ...(yield* Schema.decodeUnknownEffect(
                  Schema.Record(Schema.String, Schema.Json),
                )(params)),
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": revision,
                  "io.modelcontextprotocol/clientCapabilities": {},
                  "io.modelcontextprotocol/clientInfo": {
                    name: "test-client",
                    version: "1",
                  },
                },
              };
            }

            return yield* request(JSON.stringify(body), requestHeaders, signal);
          });

        const rpc = (method: string, params: Schema.Json = {}) =>
          Effect.gen(function* () {
            const response = yield* send(method, params);
            const envelope = yield* readMcpResponse(response);

            return {
              response,
              envelope: yield* Schema.decodeUnknownEffect(Envelope)(envelope),
            };
          });

        if (revision === "2026-07-28") {
          const discovery = yield* rpc("server/discover");

          if (discovery.response.status !== 200) {
            throw new Error(JSON.stringify(discovery.envelope));
          }
        } else {
          const initialization = yield* rpc("initialize", {
            protocolVersion: revision,
            capabilities: {},
            clientInfo: { name: "test-client", version: "1" },
          });

          const sessionId =
            initialization.response.headers.get("Mcp-Session-Id");

          if (
            !sessionId ||
            initialization.response.headers.get("MCP-Protocol-Version") !==
              revision
          ) {
            throw new Error(
              "MCP did not negotiate the requested revision and session",
            );
          }

          headers.set("Mcp-Session-Id", sessionId);
          yield* request(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/initialized",
            }),
            headers,
          );
        }

        return { rpc, send, headers };
      });

    return {
      logs,
      request,
      connect,
      providerRequests,
      directory,
      retentionDirectory: config.retentionDirectory,
      networkCalls: () => providerRequests.length,
      dispose: Effect.promise(() => current.dispose()),
      restart: Effect.promise(async () => {
        await current.dispose();
        current = start();
      }),
      pauseProvider: () => {
        pending = {
          response: Promise.withResolvers<Response>(),
          started: Promise.withResolvers<void>(),
          aborted: Promise.withResolvers<void>(),
        };
        const gate = pending;

        return {
          started: Effect.promise(() => gate.started.promise),
          aborted: Effect.promise(() => gate.aborted.promise),
          release: Effect.sync(() =>
            gate.response.resolve(
              new Response(providerResponse.clone().body, {
                status: providerResponse.status,
                headers: providerResponse.headers,
              }),
            ),
          ),
        };
      },
      setProviderResponse: (response: Response) => {
        providerResponse = response;
      },
    };
  });

export const makeHarness = makeHarnessWithConfig();
