// @effect-diagnostics unstableApiUsage:off
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { Effect, Fiber, Schema } from "effect";
import { McpSchema } from "effect/ai";

import {
  makeHarness,
  makeHarnessWithConfig,
  revisions,
} from "./mcp-harness.ts";

const inputImage = "aW5wdXQtaW1hZ2U=";

describe("image request logging", () => {
  it.effect("accepts a lowercase bearer scheme and redacts its token", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const client = yield* harness.connect("2026-07-28");
      harness.logs.length = 0;
      const headers = new Headers(client.headers);
      headers.set("Authorization", "bearer test-bearer-token");

      const response = yield* client.send(
        "tools/call",
        {
          name: "generate_image",
          arguments: { subject: "a fox test-bearer-token" },
        },
        headers,
      );

      expect(response.status).toBe(200);
      expect(harness.logs).toHaveLength(1);
      expect(harness.logs[0]).toMatchObject({
        message: {
          authentication: "authenticated",
          outcome: "success",
          prompt: { subject: "a fox [redacted]" },
        },
      });
      expect(JSON.stringify(harness.logs)).not.toContain("test-bearer-token");
    }),
  );

  for (const revision of revisions) {
    it.effect(`${revision}: logs safe request metadata and prompt text`, () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const client = yield* harness.connect(revision);
        harness.logs.length = 0;

        yield* client.rpc("tools/call", {
          name: "generate_image",
          arguments: {
            subject: "a fox",
            action: "reading",
            scene: "a library",
            composition: "close-up",
            lighting: "warm",
            style: "watercolor",
            text: "Hello",
            changes: ["add a book"],
            input: [{ data: "aW5wdXQtaW1hZ2U=", mime_type: "image/png" }],
          },
        });

        expect(harness.logs).toHaveLength(1);
        expect(harness.logs[0]).toMatchObject({
          message: {
            event: "image_request",
            time: expect.any(String),
            authentication: "authenticated",
            tool: "generate_image",
            selected_model: "openai/fixture-image-model",
            requested_model: null,
            duration_ms: expect.any(Number),
            outcome: "success",
            prompt: {
              subject: "a fox",
              action: "reading",
              scene: "a library",
              composition: "close-up",
              lighting: "warm",
              style: "watercolor",
              text: "Hello",
              changes: ["add a book"],
            },
          },
        });
        const output = JSON.stringify(harness.logs);
        expect(output).not.toContain("test-bearer-token");
        expect(output).not.toContain("fake-provider-key");
        expect(output).not.toContain("aW5wdXQtaW1hZ2U=");
        expect(output).not.toContain("AQID");
        expect(output).not.toContain("Provider caption.");
      }),
    );
  }

  it.effect(
    "logs missing and invalid authentication without reading or logging the body",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;

        for (const [authorization, authentication] of [
          [undefined, "missing"],
          ["Bearer rejected-token", "invalid"],
        ]) {
          harness.logs.length = 0;
          const headers = new Headers({ "Mcp-Name": "generate_image" });

          if (authorization) {
            headers.set("Authorization", authorization);
          }

          const response = yield* harness.request(
            `not JSON test-bearer-token rejected-token ${inputImage} AQID`,
            headers,
          );

          expect(response.status).toBe(401);
          expect(harness.logs).toHaveLength(1);
          expect(harness.logs[0]).toMatchObject({
            message: {
              event: "image_request",
              time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
              authentication,
              tool: "generate_image",
              selected_model: null,
              requested_model: null,
              duration_ms: expect.any(Number),
              outcome: "auth_rejected",
              prompt: {},
            },
          });
          const output = JSON.stringify(harness.logs);

          for (const secret of [
            "test-bearer-token",
            "rejected-token",
            inputImage,
            "AQID",
          ]) {
            expect(output).not.toContain(secret);
          }
        }

        expect(harness.networkCalls()).toBe(0);
      }),
  );

  for (const revision of revisions) {
    it.effect(
      `${revision}: logs provider failures without error bodies or image data`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          const client = yield* harness.connect(revision);
          harness.logs.length = 0;
          harness.setProviderResponse(
            Response.json(
              { error: { message: `test-bearer-token ${inputImage} AQID` } },
              { status: 500 },
            ),
          );

          const { envelope } = yield* client.rpc("tools/call", {
            name: "generate_image",
            arguments: {
              subject: `a fox test-bearer-token ${inputImage}`,
              model: "openai/gpt-image-2",
              input: [{ data: inputImage, mime_type: "image/png" }],
            },
          });

          expect(envelope.result).toMatchObject({ isError: true });
          expect(harness.logs).toHaveLength(1);
          expect(harness.logs[0]).toMatchObject({
            message: {
              event: "image_request",
              time: expect.any(String),
              authentication: "authenticated",
              tool: "generate_image",
              selected_model: null,
              requested_model: "openai/gpt-image-2",
              duration_ms: expect.any(Number),
              outcome: "failure",
              prompt: { subject: "a fox [redacted] [redacted]" },
            },
          });
          const output = JSON.stringify(harness.logs);

          for (const secret of [
            "test-bearer-token",
            "fake-provider-key",
            inputImage,
            "AQID",
          ]) {
            expect(output).not.toContain(secret);
          }
        }),
    );

    it.effect(
      `${revision}: keeps rejected tool inputs out of validation logs`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          yield* Effect.promise(() =>
            writeFile(
              join(harness.directory, "models.yml"),
              "providers:\n  openai:\n    baseUrl: https://api.openai.com/v1\n    apiKey: fake-provider-key\n    models:\n      - id: test-bearer-token\n        api: openai-images\n",
            ),
          );
          yield* harness.restart;
          const client = yield* harness.connect(revision);
          harness.logs.length = 0;
          yield* client.rpc("tools/call", {
            name: "generate_image",
            arguments: {
              subject: { data: inputImage, secret: "test-bearer-token" },
              text: "safe prompt text",
              model: "openai/test-bearer-token",
              input: [{ data: inputImage }],
            },
          });
          expect(harness.logs).toHaveLength(1);
          expect(harness.logs[0]).toMatchObject({
            message: {
              authentication: "authenticated",
              tool: "generate_image",
              selected_model: null,
              requested_model: "openai/[redacted]",
              outcome: "failure",
              prompt: { text: "safe prompt text" },
            },
          });
          const output = JSON.stringify(harness.logs);
          expect(output).not.toContain(inputImage);
          expect(output).not.toContain("test-bearer-token");
          expect(harness.networkCalls()).toBe(0);
        }),
    );
  }

  it.effect(
    "redacts secrets even when echoed in prompt fields and the provider model",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const client = yield* harness.connect("2026-07-28");
        harness.logs.length = 0;
        harness.setProviderResponse(
          Response.json({
            output: [{ type: "image_generation_call", result: "AQID" }],
            tools: [
              {
                type: "image_generation",
                model: "fixture-test-bearer-token-AQID",
              },
            ],
          }),
        );
        yield* client.rpc("tools/call", {
          name: "generate_image",
          arguments: {
            subject: `a fox test-bearer-token ${inputImage} AQID`,
            changes: ["data:image/png;base64,aW1hZ2Utc2VjcmV0"],
            input: [{ data: inputImage, mime_type: "image/png" }],
          },
        });
        expect(harness.logs).toHaveLength(1);
        expect(harness.logs[0]).toMatchObject({
          message: {
            selected_model: "openai/fixture-[redacted]-[redacted]",
            outcome: "success",
            prompt: {
              subject: "a fox [redacted] [redacted] [redacted]",
              changes: ["[redacted]"],
            },
          },
        });
        const output = JSON.stringify(harness.logs);

        for (const secret of [
          "test-bearer-token",
          inputImage,
          "AQID",
          "aW1hZ2Utc2VjcmV0",
        ]) {
          expect(output).not.toContain(secret);
        }
      }),
  );

  it.effect(
    "logs non-tool requests and Origin rejections without header data",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const client = yield* harness.connect("2026-07-28");
        harness.logs.length = 0;
        yield* client.rpc("tools/list");
        expect(harness.logs).toHaveLength(1);
        expect(harness.logs[0]).toMatchObject({
          message: {
            authentication: "authenticated",
            tool: null,
            selected_model: null,
            duration_ms: expect.any(Number),
            outcome: "success",
            prompt: {},
          },
        });
        harness.logs.length = 0;
        const headers = new Headers(client.headers);
        headers.set("Origin", "https://test-bearer-token.example");
        headers.set("Mcp-Name", inputImage);
        const response = yield* client.send("tools/list", {}, headers);
        expect(response.status).toBe(403);
        expect(harness.logs).toHaveLength(1);
        expect(harness.logs[0]).toMatchObject({
          message: {
            authentication: "authenticated",
            tool: null,
            selected_model: null,
            outcome: "origin_rejected",
            prompt: {},
          },
        });
        expect(JSON.stringify(harness.logs)).not.toContain("test-bearer-token");
        expect(JSON.stringify(harness.logs)).not.toContain(inputImage);
      }),
  );

  it.effect("redacts retained image bytes echoed in an edit prompt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const client = yield* harness.connect("2026-07-28");

      const generated = yield* client.rpc("tools/call", {
        name: "generate_image",
        arguments: { subject: "a fox" },
      });

      const result = yield* Schema.decodeUnknownEffect(
        McpSchema.CallToolResult,
      )(generated.envelope.result);

      const reference = result.content.flatMap(block =>
        block.type === "text"
          ? [...block.text.matchAll(/generated-image:[a-f0-9-]+/gu)].map(
              match => match[0],
            )
          : [],
      )[0];

      if (!reference) {
        throw new Error(
          "Image generation did not return a generated image reference",
        );
      }

      harness.logs.length = 0;
      harness.setProviderResponse(
        Response.json({
          output: [{ type: "image_generation_call", result: "BQYH" }],
        }),
      );
      yield* client.rpc("tools/call", {
        name: "generate_image",
        arguments: {
          subject: "edit the fox AQID",
          input: [{ path: reference }],
        },
      });
      expect(harness.logs).toHaveLength(1);
      expect(harness.logs[0]).toMatchObject({
        message: {
          outcome: "success",
          prompt: { subject: "edit the fox [redacted]" },
        },
      });
      expect(JSON.stringify(harness.logs)).not.toContain("AQID");
      expect(JSON.stringify(harness.logs)).not.toContain("BQYH");
    }),
  );

  for (const revision of revisions) {
    it.effect(
      `${revision}: logs refused execution prompts without image data`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarnessWithConfig({
            maxConcurrentExecutions: 1,
          });

          const client = yield* harness.connect(revision);
          const gate = harness.pauseProvider();

          const active = yield* client
            .rpc("tools/call", {
              name: "generate_image",
              arguments: { subject: "first image" },
            })
            .pipe(Effect.forkChild);

          yield* gate.started;
          harness.logs.length = 0;

          const refused = yield* client.rpc("tools/call", {
            name: "generate_image",
            arguments: {
              subject: "second image test-bearer-token",
              input: [{ data: inputImage, mime_type: "image/png" }],
            },
          });

          expect(refused.envelope.result).toMatchObject({ isError: true });
          expect(harness.logs).toHaveLength(1);
          expect(harness.logs[0]).toMatchObject({
            message: {
              authentication: "authenticated",
              tool: "generate_image",
              selected_model: null,
              outcome: "failure",
              prompt: { subject: "second image [redacted]" },
            },
          });
          expect(JSON.stringify(harness.logs)).not.toContain(inputImage);
          expect(JSON.stringify(harness.logs)).not.toContain(
            "test-bearer-token",
          );
          yield* gate.release;
          yield* Fiber.join(active);
        }),
    );
  }
});
