// @effect-diagnostics unstableApiUsage:off
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { Effect, Schema } from "effect";
import { McpSchema } from "effect/ai";

import { makeHarness, revisions } from "./mcp-harness.ts";

describe("image edit references", () => {
  for (const revision of revisions) {
    for (const encoding of ["base64 plus MIME", "data URLs"]) {
      it.effect(
        `${revision}: edits reference images supplied as ${encoding}`,
        () =>
          Effect.gen(function* () {
            const harness = yield* makeHarness;
            const client = yield* harness.connect(revision);

            const input =
              encoding === "base64 plus MIME"
                ? [
                    { data: "AQID", mime_type: "image/png" },
                    { data: "BAUG", mime_type: "image/jpeg" },
                  ]
                : [
                    { data: "data:image/png;base64,AQID" },
                    { data: "data:image/jpeg;base64,BAUG" },
                  ];

            const { envelope } = yield* client.rpc("tools/call", {
              name: "generate_image",
              arguments: { subject: "a fox", changes: ["make it blue"], input },
            });

            const result = yield* Schema.decodeUnknownEffect(
              McpSchema.CallToolResult,
            )(envelope.result);

            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toBeUndefined();
            expect(result.content).toContainEqual({
              type: "image",
              data: new Uint8Array([1, 2, 3]),
              mimeType: "image/webp",
            });
            const provider = harness.providerRequests[0];

            if (!provider) {
              throw new Error("Image edit did not reach the provider");
            }

            const body = yield* Effect.promise(() => provider.json());

            expect(body).toMatchObject({
              input: [
                {
                  content: [
                    {
                      type: "input_text",
                      text: "a fox.\n\nChanges:\n- make it blue",
                    },
                    {
                      type: "input_image",
                      image_url: "data:image/png;base64,AQID",
                    },
                    {
                      type: "input_image",
                      image_url: "data:image/jpeg;base64,BAUG",
                    },
                  ],
                },
              ],
              tools: [{ action: "edit" }],
            });
          }),
      );
    }

    it.effect(
      `${revision}: reports each generated image reference and edits those images across clients`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          const client = yield* harness.connect(revision);

          harness.setProviderResponse(
            Response.json({
              output: [
                { type: "image_generation_call", result: "AQID" },
                { type: "image_generation_call", result: "BAUG" },
              ],
              tools: [
                { type: "image_generation", model: "fixture-image-model" },
              ],
            }),
          );

          const generation = yield* client.rpc("tools/call", {
            name: "generate_image",
            arguments: { subject: "two foxes" },
          });

          const generated = yield* Schema.decodeUnknownEffect(
            McpSchema.CallToolResult,
          )(generation.envelope.result);

          const metadata = generated.content
            .filter(block => block.type === "text")
            .map(block => block.text)
            .join("\n");

          const references = Array.from(
            metadata.matchAll(/generated-image:[0-9a-f-]+/g),
            match => match[0],
          );

          expect(references).toHaveLength(2);
          expect(new Set(references).size).toBe(2);
          expect(metadata).toContain("Provider: openai");
          expect(metadata).toContain("fixture-image-model");
          expect(metadata).not.toContain("omp-image-");
          expect(generated.structuredContent).toBeUndefined();

          const anotherClient = yield* harness.connect(revision);

          const edited = yield* anotherClient.rpc("tools/call", {
            name: "generate_image",
            arguments: {
              subject: "two foxes",
              changes: ["make them blue"],
              input: references.map(path => ({ path })),
            },
          });

          const result = yield* Schema.decodeUnknownEffect(
            McpSchema.CallToolResult,
          )(edited.envelope.result);

          expect(result.isError).not.toBe(true);
          expect(result.content).toContainEqual({
            type: "image",
            data: new Uint8Array([1, 2, 3]),
            mimeType: "image/webp",
          });
          const provider = harness.providerRequests[1];

          if (!provider) {
            throw new Error("Image edit did not reach the provider");
          }

          const body = yield* Effect.promise(() => provider.json());

          expect(body).toMatchObject({
            input: [
              {
                content: [
                  {
                    type: "input_text",
                    text: "two foxes.\n\nChanges:\n- make them blue",
                  },
                  {
                    type: "input_image",
                    image_url: "data:image/webp;base64,AQID",
                  },
                  {
                    type: "input_image",
                    image_url: "data:image/webp;base64,BAUG",
                  },
                ],
              },
            ],
            tools: [{ action: "edit" }],
          });
        }),
    );
    it.effect(
      `${revision}: rejects every non-generated input.path before execution`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          const client = yield* harness.connect(revision);
          const hostImage = join(harness.directory, "private.png");
          const link = join(harness.directory, "link.png");

          yield* Effect.promise(async () => {
            await writeFile(
              hostImage,
              Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=",
                "base64",
              ),
            );
            await symlink(hostImage, link);
          });

          for (const path of [
            hostImage,
            link,
            "private.png",
            "../private.png",
            "/etc/passwd",
            "C:\\Users\\agent\\image.png",
            "generated-image:unknown",
            "",
          ]) {
            const { envelope } = yield* client.rpc("tools/call", {
              name: "generate_image",
              arguments: {
                subject: "edit",
                input: [{ path, data: "AQID", mime_type: "image/png" }],
              },
            });

            if (revision === "2025-06-18") {
              expect(envelope.error?.code).toBe(-32602);
              expect(envelope.error?.message).toContain("Invalid tool input:");
              expect(envelope.error?.message).toContain("input.path");
            } else {
              const result = yield* Schema.decodeUnknownEffect(
                McpSchema.CallToolResult,
              )(envelope.result);

              expect(result.isError).toBe(true);
              expect(result.content).toContainEqual({
                type: "text",
                text: expect.stringContaining("Invalid tool input:"),
              });
              expect(result.content).toContainEqual({
                type: "text",
                text: expect.stringContaining("input.path"),
              });
            }
          }

          expect(harness.networkCalls()).toBe(0);
        }),
    );
  }
});
