// @effect-diagnostics unstableApiUsage:off
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  imageGenSchema,
  imageGenTool,
} from "@oh-my-pi/pi-coding-agent/tools/image-gen";

import { Effect, Fiber, Schema } from "effect";
import { McpSchema } from "effect/ai";

import {
  makeHarness,
  makeHarnessWithConfig,
  revisions,
} from "./mcp-harness.ts";

const ListedTools = Schema.Struct({ tools: Schema.Array(McpSchema.Tool) });

const makeBackgroundHarness = (
  imageRole = "openai-codex/gpt-image-2",
  modelsConfig = "providers:\n  openai-codex:\n    baseUrl: https://chatgpt.com/backend-api\n",
) =>
  Effect.gen(function* () {
    const harness = yield* makeHarnessWithConfig({}, [
      "openai-codex",
      "openai",
      "deepinfra",
      "xai",
    ]);

    yield* Effect.promise(() =>
      writeFile(
        join(harness.directory, "config.yml"),
        `modelRoles:\n  default: openai-codex/gpt-6.1-sol\n  image: ${imageRole}\n`,
      ),
    );
    yield* Effect.promise(() =>
      writeFile(join(harness.directory, "models.yml"), modelsConfig),
    );
    harness.setProviderResponse(
      new Response(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            output: [{ type: "image_generation_call", result: "AQID" }],
            tools: [{ type: "image_generation", model: "gpt-image-2-codex" }],
          },
        })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    );
    yield* harness.restart;

    return harness;
  });

describe("authenticated MCP endpoint", () => {
  it.effect("rejects requests before parsing MCP or reaching providers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;

      for (const headers of [
        {},
        { Authorization: "Bearer wrong" },
        { Authorization: "Basic test-bearer-token" },
      ]) {
        const response = yield* harness.request(
          "not JSON",
          new Headers(headers),
        );

        expect(response.status).toBe(401);
      }

      for (const origin of ["https://browser.example", "null", ""]) {
        const response = yield* harness.request(
          "not JSON",
          new Headers({
            Authorization: "Bearer test-bearer-token",
            Origin: origin,
          }),
        );

        expect(response.status).toBe(403);
      }

      expect(harness.networkCalls()).toBe(0);
    }),
  );

  for (const revision of revisions) {
    it.effect(`${revision}: discovers only the original OMP image tool`, () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const client = yield* harness.connect(revision);
        const { response, envelope } = yield* client.rpc("tools/list");
        expect(response.status).toBe(200);
        expect(envelope.error).toBeUndefined();

        const listed = yield* Schema.decodeUnknownEffect(ListedTools)(
          envelope.result,
        );

        expect(listed.tools).toHaveLength(1);
        expect(listed.tools[0]?.name).toBe(imageGenTool.name);
        expect(listed.tools[0]?.description).toBe(imageGenTool.description);

        const original = imageGenSchema.toJsonSchema({
          io: "input",
          target: "draft-2020-12",
          dialect: null,
        });

        const originalJson = JSON.stringify(original);

        const expectedJson = originalJson.replace(
          '"input image path"',
          '"generated image reference only; host paths are not accepted"',
        );

        expect(listed.tools[0]?.inputSchema).toEqual(JSON.parse(expectedJson));
        expect(harness.networkCalls()).toBe(0);

        if (revision === "2026-07-28") {
          expect(response.headers.get("Mcp-Session-Id")).toBeNull();
        }
      }),
    );
    it.effect(
      `${revision}: generates an image using OMP prompt and profile selection`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          const client = yield* harness.connect(revision);

          const { response, envelope } = yield* client.rpc("tools/call", {
            name: "generate_image",
            arguments: {
              subject: "a fox",
              action: "reading",
              scene: "a library",
              composition: "close-up",
              lighting: "warm.",
              style: "watercolor",
              text: "Hello",
              aspect_ratio: "3:2",
              image_size: "1536x1024",
            },
          });

          expect(response.status).toBe(200);
          expect(envelope.error).toBeUndefined();

          const result = yield* Schema.decodeUnknownEffect(
            McpSchema.CallToolResult,
          )(envelope.result);

          expect(result.structuredContent).toBeUndefined();
          expect(result.isError).not.toBe(true);
          expect(result.content).toContainEqual({
            type: "image",
            data: new Uint8Array([1, 2, 3]),
            mimeType: "image/webp",
          });
          expect(result.content).toContainEqual({
            type: "text",
            text: expect.stringContaining(
              "Provider: openai\nModel: fixture-image-model (catalog entry openai/gpt-image-2)\nGenerated 1 image(s):",
            ),
          });
          expect(result.content).toContainEqual({
            type: "text",
            text: expect.stringContaining(
              "(1536x1024, quality high)\n\nProvider caption.",
            ),
          });
          expect(harness.providerRequests).toHaveLength(1);
          const provider = harness.providerRequests[0];

          if (!provider) {
            throw new Error("OMP did not reach the provider fetch hook");
          }

          expect(provider?.url).toBe("https://api.openai.com/v1/responses");
          expect(provider?.headers.get("authorization")).toBe(
            "Bearer fake-provider-key",
          );
          const body = yield* Effect.promise(() => provider.json());
          expect(body).not.toHaveProperty("tools.0.background");
          expect(body).toMatchObject({
            model: "gpt-5.4",
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "a fox, reading, a library. close-up. warm. watercolor.\n\nText: Hello",
                  },
                ],
              },
            ],
            tools: [
              {
                type: "image_generation",
                model: "gpt-image-2",
                action: "generate",
                output_format: "webp",
                size: "1536x1024",
              },
            ],
            store: false,
          });
        }),
    );

    it.effect(
      `${revision}: omits auto for the unsupported OpenAI platform image model`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          const client = yield* harness.connect(revision);

          const { response, envelope } = yield* client.rpc("tools/call", {
            name: "generate_image",
            arguments: { subject: "a fox", background: "auto" },
          });

          expect(response.status).toBe(200);
          expect(envelope.error).toBeUndefined();

          const result = yield* Schema.decodeUnknownEffect(
            McpSchema.CallToolResult,
          )(envelope.result);

          expect(result.isError).not.toBe(true);
          expect(result.content).toContainEqual({
            type: "image",
            data: new Uint8Array([1, 2, 3]),
            mimeType: "image/webp",
          });
          expect(harness.providerRequests).toHaveLength(1);
          const provider = harness.providerRequests[0];

          if (!provider) {
            throw new Error("OMP did not reach the provider fetch hook");
          }

          expect(provider.url).toBe("https://api.openai.com/v1/responses");
          expect(
            yield* Effect.promise(() => provider.json()),
          ).not.toHaveProperty("tools.0.background");
        }),
    );

    for (const background of [undefined, "auto"]) {
      it.live(
        `${revision}: preserves DeepInfra defaults with ${background ?? "omitted"} background`,
        () =>
          Effect.gen(function* () {
            const harness = yield* makeHarnessWithConfig({}, ["deepinfra"]);
            const client = yield* harness.connect(revision);
            const gate = harness.pauseProvider();

            const args = {
              subject: "a fox",
              model: "deepinfra/black-forest-labs/FLUX-2-pro",
            };

            const fiber = yield* client
              .rpc("tools/call", {
                name: "generate_image",
                arguments:
                  background === undefined ? args : { ...args, background },
              })
              .pipe(Effect.forkChild);

            yield* gate.started;
            const provider = harness.providerRequests[0];

            if (!provider) {
              throw new Error("OMP did not reach the provider fetch hook");
            }

            const body = yield* Schema.decodeUnknownEffect(
              Schema.Record(Schema.String, Schema.Json),
            )(yield* Effect.promise(() => provider.json()));

            // Model the strict host: even background: "auto" is an unknown field.
            harness.setProviderResponse(
              Object.hasOwn(body, "background")
                ? Response.json(
                    { error: { message: "Unknown field: background" } },
                    { status: 400 },
                  )
                : Response.json({ data: [{ b64_json: "AQID" }] }),
            );
            yield* gate.release;
            const { response, envelope } = yield* Fiber.join(fiber);

            expect(response.status).toBe(200);
            expect(envelope.error).toBeUndefined();

            const result = yield* Schema.decodeUnknownEffect(
              McpSchema.CallToolResult,
            )(envelope.result);

            expect(result.isError).not.toBe(true);
            expect(result.content).toContainEqual({
              type: "image",
              data: new Uint8Array([1, 2, 3]),
              mimeType: "image/png",
            });
            expect(harness.providerRequests).toHaveLength(1);
            expect(provider.url).toBe(
              "https://api.deepinfra.com/v1/openai/images/generations",
            );
            expect(body).toMatchObject({
              model: "black-forest-labs/FLUX-2-pro",
              prompt: "a fox.",
            });
            expect(body).not.toHaveProperty("background");
          }).pipe(Effect.timeout("2 seconds")),
      );
    }

    for (const background of ["transparent", "opaque", "auto"]) {
      it.effect(
        `${revision}: forwards a ${background} background through the verified Codex hosted image model`,
        () =>
          Effect.gen(function* () {
            const harness = yield* makeBackgroundHarness();
            const client = yield* harness.connect(revision);

            const { response, envelope } = yield* client.rpc("tools/call", {
              name: "generate_image",
              arguments: { subject: "a fox", background },
            });

            expect(response.status).toBe(200);
            expect(envelope.error).toBeUndefined();

            const result = yield* Schema.decodeUnknownEffect(
              McpSchema.CallToolResult,
            )(envelope.result);

            expect(result.isError).not.toBe(true);
            expect(result.content).toContainEqual({
              type: "image",
              data: new Uint8Array([1, 2, 3]),
              mimeType: "image/webp",
            });
            expect(result.content).toContainEqual({
              type: "text",
              text: expect.stringContaining(
                "Provider: openai-codex\nModel: gpt-image-2-codex (catalog entry openai-codex/gpt-image-2)",
              ),
            });
            expect(harness.providerRequests).toHaveLength(1);
            const provider = harness.providerRequests[0];

            if (!provider) {
              throw new Error("OMP did not reach the provider fetch hook");
            }

            expect(provider.url).toBe(
              "https://chatgpt.com/backend-api/codex/responses",
            );
            const body = yield* Effect.promise(() => provider.json());

            expect(body).toMatchObject({
              model: "gpt-6.1-sol",
              stream: true,
              tools: [{ type: "image_generation", background }],
            });
            expect(body).not.toHaveProperty("tools.0.model");
          }),
      );
    }

    for (const { label, modelsConfig } of [
      {
        label: "custom Codex provider endpoint",
        modelsConfig:
          "providers:\n  openai-codex:\n    baseUrl: https://codex.example/backend-api\n",
      },
      {
        label: "custom Codex hosted carrier endpoint",
        modelsConfig:
          "providers:\n  openai-codex:\n    baseUrl: https://chatgpt.com/backend-api\n    apiKey: fake-provider-key\n    models:\n      - id: gpt-6.1-sol\n        api: openai-codex-responses\n        baseUrl: https://codex.example/backend-api\n",
      },
    ]) {
      it.effect(
        `${revision}: rejects transparent at a ${label} before provider requests`,
        () =>
          Effect.gen(function* () {
            const harness = yield* makeBackgroundHarness(
              "openai-codex/gpt-image-2",
              modelsConfig,
            );

            const client = yield* harness.connect(revision);

            const { response, envelope } = yield* client.rpc("tools/call", {
              name: "generate_image",
              arguments: {
                subject: "a fox",
                model: "openai-codex/gpt-image-2",
                background: "transparent",
              },
            });

            expect(response.status).toBe(200);

            const messages = [
              'supports background "transparent"',
              "openai-codex/gpt-image-2",
            ];

            if (revision === "2025-06-18") {
              expect(envelope.error?.code).toBe(-32602);

              for (const message of messages) {
                expect(envelope.error?.message).toContain(message);
              }
            } else {
              expect(envelope.error).toBeUndefined();

              const result = yield* Schema.decodeUnknownEffect(
                McpSchema.CallToolResult,
              )(envelope.result);

              expect(result.isError).toBe(true);

              for (const message of messages) {
                expect(result.content).toContainEqual({
                  type: "text",
                  text: expect.stringContaining(message),
                });
              }
            }

            expect(harness.networkCalls()).toBe(0);
          }),
      );

      it.live(`${revision}: omits auto for a strict ${label}`, () =>
        Effect.gen(function* () {
          const harness = yield* makeBackgroundHarness(
            "openai-codex/gpt-image-2",
            modelsConfig,
          );

          const client = yield* harness.connect(revision);
          const gate = harness.pauseProvider();

          const fiber = yield* client
            .rpc("tools/call", {
              name: "generate_image",
              arguments: {
                subject: "a fox",
                model: "openai-codex/gpt-image-2",
                background: "auto",
              },
            })
            .pipe(Effect.forkChild);

          yield* gate.started;
          const provider = harness.providerRequests[0];

          if (!provider) {
            throw new Error("OMP did not reach the provider fetch hook");
          }

          const body = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              model: Schema.String,
              stream: Schema.Boolean,
              tools: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
            }),
          )(yield* Effect.promise(() => provider.json()));

          // The custom host rejects every background field, including auto.
          if (body.tools.some(tool => Object.hasOwn(tool, "background"))) {
            harness.setProviderResponse(
              Response.json(
                { error: { message: "Unknown field: background" } },
                { status: 400 },
              ),
            );
          }

          yield* gate.release;
          const { response, envelope } = yield* Fiber.join(fiber);
          expect(response.status).toBe(200);
          expect(envelope.error).toBeUndefined();

          const result = yield* Schema.decodeUnknownEffect(
            McpSchema.CallToolResult,
          )(envelope.result);

          expect(result.isError).not.toBe(true);
          expect(result.content).toContainEqual({
            type: "image",
            data: new Uint8Array([1, 2, 3]),
            mimeType: "image/webp",
          });
          expect(harness.providerRequests).toHaveLength(1);
          expect(provider.url).toBe(
            "https://codex.example/backend-api/codex/responses",
          );
          expect(body).toMatchObject({
            model: "gpt-6.1-sol",
            stream: true,
            tools: [{ type: "image_generation" }],
          });
          expect(body).not.toHaveProperty("tools.0.background");
        }).pipe(Effect.timeout("2 seconds")),
      );
    }

    for (const model of [
      "openai/gpt-image-2",
      "deepinfra/black-forest-labs/FLUX-2-pro",
      "xai/grok-imagine-image",
    ]) {
      for (const background of ["transparent", "opaque"]) {
        it.effect(
          `${revision}: rejects ${model} for ${background} before provider requests`,
          () =>
            Effect.gen(function* () {
              const harness = yield* makeBackgroundHarness();
              const client = yield* harness.connect(revision);

              const { envelope } = yield* client.rpc("tools/call", {
                name: "generate_image",
                arguments: { subject: "a fox", model, background },
              });

              if (revision === "2025-06-18") {
                expect(envelope.error?.code).toBe(-32602);
                expect(envelope.error?.message).toContain(
                  "supports background",
                );
                expect(envelope.error?.message).toContain(background);
                expect(envelope.error?.message).toContain(model);
              } else {
                expect(envelope.error).toBeUndefined();

                const result = yield* Schema.decodeUnknownEffect(
                  McpSchema.CallToolResult,
                )(envelope.result);

                expect(result.isError).toBe(true);

                for (const message of [
                  "supports background",
                  background,
                  model,
                ]) {
                  expect(result.content).toContainEqual({
                    type: "text",
                    text: expect.stringContaining(message),
                  });
                }
              }

              expect(harness.networkCalls()).toBe(0);
            }),
        );
      }
    }

    for (const imageRole of [
      "openai/gpt-image-2",
      "deepinfra/black-forest-labs/FLUX-2-pro",
    ]) {
      it.effect(
        `${revision}: skips unsupported ${imageRole} without dropping the background preference`,
        () =>
          Effect.gen(function* () {
            const harness = yield* makeBackgroundHarness(imageRole);
            const client = yield* harness.connect(revision);

            const { envelope } = yield* client.rpc("tools/call", {
              name: "generate_image",
              arguments: { subject: "a fox", background: "transparent" },
            });

            expect(envelope.error).toBeUndefined();

            const result = yield* Schema.decodeUnknownEffect(
              McpSchema.CallToolResult,
            )(envelope.result);

            expect(result.isError).not.toBe(true);
            expect(result.content).toContainEqual({
              type: "image",
              data: new Uint8Array([1, 2, 3]),
              mimeType: "image/webp",
            });
            expect(harness.providerRequests).toHaveLength(1);
            const provider = harness.providerRequests[0];

            if (!provider) {
              throw new Error("OMP did not reach the provider fetch hook");
            }

            expect(provider.url).toBe(
              "https://chatgpt.com/backend-api/codex/responses",
            );
            expect(yield* Effect.promise(() => provider.json())).toMatchObject({
              tools: [{ type: "image_generation", background: "transparent" }],
            });
          }),
      );
    }

    it.effect(
      `${revision}: identifies invalid original-tool arguments without provider calls`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          const client = yield* harness.connect(revision);

          const invalidInputs: Array<readonly [Schema.Json, string]> = [
            [{}, "subject"],
            [{ subject: 123 }, "subject"],
            [{ subject: "fox", aspect_ratio: "wide" }, "aspect_ratio"],
            [{ subject: "fox", input: [{ data: 42 }] }, "data"],
          ];

          for (const [arguments_, problem] of invalidInputs) {
            const { envelope } = yield* client.rpc("tools/call", {
              name: "generate_image",
              arguments: arguments_,
            });

            if (revision === "2025-06-18") {
              expect(envelope.error?.code).toBe(-32602);
              expect(envelope.error?.message).toContain("Invalid tool input:");
              expect(envelope.error?.message).toContain(problem);
            } else {
              const result = yield* Schema.decodeUnknownEffect(
                McpSchema.CallToolResult,
              )(envelope.result);

              expect(result.isError).toBe(true);
              expect(result.content).toContainEqual({
                type: "text",
                text: expect.stringContaining(problem),
              });
            }
          }

          expect(harness.networkCalls()).toBe(0);
        }),
    );
    it.effect(
      `${revision}: preserves OMP refusals and empty image results as successful text`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          const client = yield* harness.connect(revision);

          for (const [output, expected] of [
            [[], "No image data returned."],
            [
              [
                {
                  type: "message",
                  content: [
                    {
                      type: "refusal",
                      refusal: "I cannot generate that image.",
                    },
                  ],
                },
              ],
              "No image data returned.\n\nI cannot generate that image.",
            ],
          ]) {
            harness.setProviderResponse(Response.json({ output }));

            const { envelope } = yield* client.rpc("tools/call", {
              name: "generate_image",
              arguments: { subject: "fox", model: "openai/gpt-image-2" },
            });

            expect(envelope.error).toBeUndefined();

            const result = yield* Schema.decodeUnknownEffect(
              McpSchema.CallToolResult,
            )(envelope.result);

            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toBeUndefined();
            expect(result.content).toEqual([{ type: "text", text: expected }]);
          }

          expect(harness.networkCalls()).toBe(2);
        }),
    );

    it.effect(
      `${revision}: flags execution failures without exposing credentials or internals`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          const client = yield* harness.connect(revision);
          harness.setProviderResponse(
            Response.json(
              {
                error: {
                  message:
                    "fake-provider-key /private/host/agent.db provider stack trace",
                },
              },
              { status: 400 },
            ),
          );

          const { envelope } = yield* client.rpc("tools/call", {
            name: "generate_image",
            arguments: { subject: "fox", model: "openai/gpt-image-2" },
          });

          expect(envelope.error).toBeUndefined();

          const result = yield* Schema.decodeUnknownEffect(
            McpSchema.CallToolResult,
          )(envelope.result);

          expect(result.isError).toBe(true);
          expect(result.structuredContent).toBeUndefined();
          expect(result.content).toEqual([
            { type: "text", text: "Image request failed." },
          ]);

          expect(harness.networkCalls()).toBe(1);
        }),
    );
    it.effect(
      `${revision}: reports original OMP argument validation before provider requests`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          const client = yield* harness.connect(revision);

          for (const [arguments_, problem] of [
            [
              { subject: "fox", model: "nonexistent/private-model" },
              "Image model selector did not match an available image model: nonexistent/private-model",
            ],
            [
              { subject: "fox", input: [{}] },
              "input entries must include either path or data.",
            ],
            [
              { subject: "fox", input: [{ data: "AQID" }] },
              "mime_type is required when providing raw base64 data.",
            ],
          ] satisfies ReadonlyArray<readonly [Schema.Json, string]>) {
            const { envelope } = yield* client.rpc("tools/call", {
              name: "generate_image",
              arguments: arguments_,
            });

            if (revision === "2025-06-18") {
              expect(envelope.error?.code).toBe(-32602);
              expect(envelope.error?.message).toContain(problem);
            } else {
              const result = yield* Schema.decodeUnknownEffect(
                McpSchema.CallToolResult,
              )(envelope.result);

              expect(result.isError).toBe(true);
              expect(result.content).toEqual([
                { type: "text", text: "Invalid tool input: " + problem },
              ]);
            }
          }

          expect(harness.networkCalls()).toBe(0);
        }),
    );

    it.effect(
      `${revision}: authenticates every request even after discovery or initialization`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          const client = yield* harness.connect(revision);
          const missing = new Headers(client.headers);
          missing.delete("Authorization");
          const wrong = new Headers(client.headers);
          wrong.set("Authorization", "Bearer wrong");

          for (const headers of [missing, wrong]) {
            const response = yield* client.send(
              "tools/call",
              { name: "generate_image", arguments: { subject: "fox" } },
              headers,
            );

            expect(response.status).toBe(401);
          }

          const origin = new Headers(client.headers);
          origin.set("Origin", "null");

          const denied = yield* client.send(
            "tools/call",
            { name: "generate_image", arguments: { subject: "fox" } },
            origin,
          );

          expect(denied.status).toBe(403);
          expect(harness.networkCalls()).toBe(0);
        }),
    );

    it.effect(
      `${revision}: keeps the startup OMP context across requests`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          const client = yield* harness.connect(revision);
          yield* Effect.promise(() =>
            writeFile(
              join(harness.directory, "config.yml"),
              "modelRoles:\n  default: missing/changed-carrier\n  image: missing/changed-image\n",
            ),
          );

          for (let call = 0; call < 2; call++) {
            yield* Effect.promise(() =>
              writeFile(
                join(harness.directory, "models.yml"),
                "providers:\n  openai:\n    baseUrl: https://changed-model-config.invalid\n",
              ),
            );

            const { envelope } = yield* client.rpc("tools/call", {
              name: "generate_image",
              arguments: { subject: "fox" },
            });

            const result = yield* Schema.decodeUnknownEffect(
              McpSchema.CallToolResult,
            )(envelope.result);

            expect(result.isError).not.toBe(true);
          }

          expect(harness.networkCalls()).toBe(2);
          expect(harness.providerRequests.map(request => request.url)).toEqual([
            "https://api.openai.com/v1/responses",
            "https://api.openai.com/v1/responses",
          ]);
        }),
    );

    it.live(
      `${revision}: passes HTTP request cancellation to the original OMP tool`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          const client = yield* harness.connect(revision);
          const gate = harness.pauseProvider();
          const abort = new AbortController();

          const fiber = yield* client
            .send(
              "tools/call",
              { name: "generate_image", arguments: { subject: "fox" } },
              undefined,
              abort.signal,
            )
            .pipe(Effect.forkChild);

          yield* gate.started;
          abort.abort();
          yield* gate.aborted;
          yield* Fiber.interrupt(fiber);
          expect(harness.networkCalls()).toBe(1);
        }).pipe(Effect.timeout("2 seconds")),
    );

    it.live(
      `${revision}: cancels in-flight OMP work when the endpoint is disposed`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          const client = yield* harness.connect(revision);
          const gate = harness.pauseProvider();

          const fiber = yield* client
            .send("tools/call", {
              name: "generate_image",
              arguments: { subject: "fox" },
            })
            .pipe(Effect.forkChild);

          yield* gate.started;
          yield* harness.dispose;
          yield* gate.aborted;
          yield* Fiber.interrupt(fiber);
          expect(harness.networkCalls()).toBe(1);
        }).pipe(Effect.timeout("2 seconds")),
    );
    it.effect(
      `${revision}: passes an explicit hosted image model selector unchanged`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          const client = yield* harness.connect(revision);

          const { envelope } = yield* client.rpc("tools/call", {
            name: "generate_image",
            arguments: {
              subject: "fox",
              model: "openai/gpt-image-1.5",
              image_size: "1024x1024",
              changes: ["make the scarf red"],
            },
          });

          const result = yield* Schema.decodeUnknownEffect(
            McpSchema.CallToolResult,
          )(envelope.result);

          expect(result.content).toContainEqual({
            type: "text",
            text: expect.stringContaining("catalog entry openai/gpt-image-1.5"),
          });
          const provider = harness.providerRequests[0];

          if (!provider) {
            throw new Error("OMP did not reach the provider fetch hook");
          }

          const body = yield* Effect.promise(() => provider.json());
          expect(body).toMatchObject({
            model: "gpt-5.4",
            tools: [
              {
                type: "image_generation",
                model: "gpt-image-1.5",
                action: "generate",
                size: "1024x1024",
              },
            ],
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "fox.\n\nChanges:\n- make the scarf red",
                  },
                ],
              },
            ],
          });
          expect(harness.networkCalls()).toBe(1);
        }),
    );
  }
});
