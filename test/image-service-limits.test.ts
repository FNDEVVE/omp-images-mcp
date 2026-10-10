// @effect-diagnostics unstableApiUsage:off
import { describe, expect, it } from "@effect/vitest";

import { Effect, Fiber, Schema } from "effect";
import { McpSchema } from "effect/ai";

import {
  makeHarness,
  makeHarnessWithConfig,
  revisions,
} from "./mcp-harness.ts";

const imageRequest = {
  name: "generate_image",
  arguments: { subject: "a fox" },
};

const decodeResult = Schema.decodeUnknownEffect(McpSchema.CallToolResult);

describe("image execution admission", () => {
  for (const revision of revisions) {
    it.live(
      `${revision}: rejects the ninth execution without queuing and recovers capacity`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          const client = yield* harness.connect(revision);
          const held = [];

          for (let index = 0; index < 8; index++) {
            const gate = harness.pauseProvider();

            const fiber = yield* client
              .rpc("tools/call", imageRequest)
              .pipe(Effect.forkChild);

            yield* gate.started;
            held.push({ gate, fiber });
          }

          const rejected = yield* client.rpc("tools/call", imageRequest);
          const result = yield* decodeResult(rejected.envelope.result);
          expect(result.isError).toBe(true);
          expect(result.content).toEqual([
            {
              type: "text",
              text: "Image execution capacity reached (8 concurrent requests). Try again after an active request finishes.",
            },
          ]);
          expect(harness.networkCalls()).toBe(8);

          const otherClient = yield* harness.connect(revision);
          const listed = yield* otherClient.rpc("tools/list");
          expect(listed.response.status).toBe(200);
          expect(listed.envelope.error).toBeUndefined();
          expect(harness.networkCalls()).toBe(8);

          const first = held.shift();

          if (!first) {
            throw new Error("Missing held execution");
          }

          yield* first.gate.release;
          const completed = yield* Fiber.join(first.fiber);
          expect(
            (yield* decodeResult(completed.envelope.result)).isError,
          ).not.toBe(true);

          const replacement = yield* client.rpc("tools/call", imageRequest);
          expect(
            (yield* decodeResult(replacement.envelope.result)).isError,
          ).not.toBe(true);
          expect(harness.networkCalls()).toBe(9);

          for (const { gate, fiber } of held) {
            yield* gate.release;
            yield* Fiber.join(fiber);
          }
        }).pipe(Effect.timeout("4 seconds")),
    );
  }

  it.live(
    "uses the startup concurrency limit and releases capacity after failure",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarnessWithConfig({
          maxConcurrentExecutions: 1,
        });

        const client = yield* harness.connect("2026-07-28");
        const gate = harness.pauseProvider();

        const active = yield* client
          .rpc("tools/call", imageRequest)
          .pipe(Effect.forkChild);

        yield* gate.started;
        const rejected = yield* client.rpc("tools/call", imageRequest);
        expect((yield* decodeResult(rejected.envelope.result)).isError).toBe(
          true,
        );
        expect(harness.networkCalls()).toBe(1);
        harness.setProviderResponse(
          Response.json(
            { error: { message: "provider unavailable" } },
            { status: 400 },
          ),
        );
        yield* gate.release;
        const failed = yield* Fiber.join(active);
        expect((yield* decodeResult(failed.envelope.result)).isError).toBe(
          true,
        );
        harness.setProviderResponse(
          Response.json({
            output: [{ type: "image_generation_call", result: "AQID" }],
          }),
        );
        const retry = yield* client.rpc("tools/call", imageRequest);
        expect((yield* decodeResult(retry.envelope.result)).isError).not.toBe(
          true,
        );
        expect(harness.networkCalls()).toBe(3);
      }).pipe(Effect.timeout("4 seconds")),
  );
});

describe("MCP request body admission", () => {
  it.effect(
    "rejects bodies above the default 50 MiB without executing the image tool",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const client = yield* harness.connect("2025-11-25");

        const response = yield* client.send("tools/call", {
          name: "generate_image",
          arguments: { subject: "x".repeat(50 * 1024 * 1024) },
        });

        expect(response.status).toBe(413);
        expect(yield* Effect.promise(() => response.text())).toContain(
          "Request body exceeds",
        );
        expect(harness.networkCalls()).toBe(0);
      }),
  );
  it.effect(
    "accepts the configured byte boundary and rejects one extra byte despite a smaller Content-Length",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarnessWithConfig({
          maxRequestBodyBytes: 512,
        });

        const client = yield* harness.connect("2025-11-25");

        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: imageRequest,
        }).padEnd(512, " ");

        const accepted = yield* harness.request(body, client.headers);
        expect(accepted.status).toBe(200);
        expect(harness.networkCalls()).toBe(1);
        const headers = new Headers(client.headers);
        headers.set("Content-Length", "1");
        const rejected = yield* harness.request(body + " ", headers);
        expect(rejected.status).toBe(413);
        expect(harness.networkCalls()).toBe(1);
      }),
  );

  it.effect("counts UTF-8 bytes rather than characters", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarnessWithConfig({
        maxRequestBodyBytes: 512,
      });

      const client = yield* harness.connect("2025-11-25");

      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "generate_image",
          arguments: { subject: "é".repeat(240) },
        },
      });

      expect(body.length).toBeLessThan(512);
      const rejected = yield* harness.request(body, client.headers);
      expect(rejected.status).toBe(413);
      expect(harness.networkCalls()).toBe(0);
    }),
  );

  it.effect(
    "stops consuming an oversized streamed body before running the tool",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarnessWithConfig({
          maxRequestBodyBytes: 512,
        });

        const client = yield* harness.connect("2025-11-25");
        let pulls = 0;
        let cancelled = false;

        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls++;
              controller.enqueue(new Uint8Array(256));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        );

        const rejected = yield* harness.request(body, client.headers);
        expect(rejected.status).toBe(413);
        expect(pulls).toBe(3);
        expect(cancelled).toBe(true);
        expect(harness.networkCalls()).toBe(0);
      }),
  );
});
