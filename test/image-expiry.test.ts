// @effect-diagnostics unstableApiUsage:off
import { execFileSync } from "node:child_process";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { Duration, Effect, Schema } from "effect";
import { McpSchema } from "effect/ai";
import { TestClock } from "effect/testing";

import {
  makeHarness,
  makeHarnessWithConfig,
  revisions,
} from "./mcp-harness.ts";

const generatedReference = (result: McpSchema.CallToolResult) => {
  const metadata = result.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n");

  const reference = metadata.match(/generated-image:[0-9a-f-]+/)?.[0];

  if (!reference) {
    throw new Error("Generation did not return a generated image reference");
  }

  return reference;
};

const expectUnavailable = (result: McpSchema.CallToolResult) => {
  expect(result.isError).toBe(true);
  expect(result.content).toContainEqual({
    type: "text",
    text: expect.stringContaining("re-upload"),
  });
};

const storedFile = (directory: string) =>
  Effect.promise(async () => {
    const filename = (await readdir(directory))[0];

    if (!filename) {
      throw new Error("Generation did not retain an image file");
    }

    return join(directory, filename);
  });

describe("generated image expiry", () => {
  it.effect(
    "keeps the default 24-hour deadline across downtime and expires on lookup between sweeps",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const client = yield* harness.connect("2026-07-28");

        const generation = yield* client.rpc("tools/call", {
          name: "generate_image",
          arguments: { subject: "default lifetime" },
        });

        const generated = yield* Schema.decodeUnknownEffect(
          McpSchema.CallToolResult,
        )(generation.envelope.result);

        const reference = generatedReference(generated);

        yield* harness.dispose;
        yield* TestClock.adjust(86_399_999);
        yield* harness.restart;
        const restarted = yield* harness.connect("2026-07-28");

        const before = yield* restarted.rpc("tools/call", {
          name: "generate_image",
          arguments: {
            subject: "last millisecond",
            input: [{ path: reference }],
          },
        });

        expect(
          (yield* Schema.decodeUnknownEffect(McpSchema.CallToolResult)(
            before.envelope.result,
          )).isError,
        ).not.toBe(true);
        yield* TestClock.adjust(1);

        const expired = yield* restarted.rpc("tools/call", {
          name: "generate_image",
          arguments: { subject: "deadline", input: [{ path: reference }] },
        });

        expectUnavailable(
          yield* Schema.decodeUnknownEffect(McpSchema.CallToolResult)(
            expired.envelope.result,
          ),
        );
        expect(harness.networkCalls()).toBe(2);
      }),
  );

  for (const revision of revisions) {
    it.effect(
      `${revision}: references survive a new service layer until the original deadline`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarnessWithConfig({
            retention: Duration.minutes(2),
          });

          const client = yield* harness.connect(revision);

          const generation = yield* client.rpc("tools/call", {
            name: "generate_image",
            arguments: { subject: "original" },
          });

          const generated = yield* Schema.decodeUnknownEffect(
            McpSchema.CallToolResult,
          )(generation.envelope.result);

          const reference = generatedReference(generated);

          yield* TestClock.adjust("1 minute");
          yield* harness.restart;
          const restarted = yield* harness.connect(revision);

          const before = yield* restarted.rpc("tools/call", {
            name: "generate_image",
            arguments: {
              subject: "edit after restart",
              input: [{ path: reference }],
            },
          });

          const edited = yield* Schema.decodeUnknownEffect(
            McpSchema.CallToolResult,
          )(before.envelope.result);

          expect(edited.isError).not.toBe(true);
          expect(harness.networkCalls()).toBe(2);
          yield* TestClock.adjust("1 minute");

          const after = yield* restarted.rpc("tools/call", {
            name: "generate_image",
            arguments: { subject: "expired", input: [{ path: reference }] },
          });

          if (revision === "2025-06-18") {
            expect(after.envelope.error?.code).toBe(-32602);
            expect(after.envelope.error?.message).toContain("re-upload");
          } else {
            expectUnavailable(
              yield* Schema.decodeUnknownEffect(McpSchema.CallToolResult)(
                after.envelope.result,
              ),
            );
          }

          expect(harness.networkCalls()).toBe(2);
        }),
    );
  }

  it.effect(
    "startup sweeps expired files left by an offline service without deleting live references",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarnessWithConfig({
          retention: Duration.minutes(2),
        });

        const client = yield* harness.connect("2026-07-28");

        yield* client.rpc("tools/call", {
          name: "generate_image",
          arguments: { subject: "older" },
        });
        const expiredPath = yield* storedFile(harness.retentionDirectory);

        yield* TestClock.adjust("1 minute");

        const generation = yield* client.rpc("tools/call", {
          name: "generate_image",
          arguments: { subject: "newer" },
        });

        const generated = yield* Schema.decodeUnknownEffect(
          McpSchema.CallToolResult,
        )(generation.envelope.result);

        const reference = generatedReference(generated);

        yield* harness.dispose;
        yield* TestClock.adjust("1 minute");
        yield* harness.restart;
        const restarted = yield* harness.connect("2026-07-28");

        const files = yield* Effect.promise(() =>
          readdir(harness.retentionDirectory),
        );

        expect(files).toHaveLength(1);
        expect(files).not.toContain(expiredPath.split("/").at(-1));

        const edit = yield* restarted.rpc("tools/call", {
          name: "generate_image",
          arguments: { subject: "still live", input: [{ path: reference }] },
        });

        expect(
          (yield* Schema.decodeUnknownEffect(McpSchema.CallToolResult)(
            edit.envelope.result,
          )).isError,
        ).not.toBe(true);
      }),
  );

  it.effect(
    "periodically removes unused files at their creation-time deadline and removes OMP temporary outputs",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarnessWithConfig({
          retention: Duration.minutes(1),
        });

        const client = yield* harness.connect("2026-07-28");

        yield* TestClock.adjust("7 minutes");
        const before = yield* Effect.promise(() => readdir(tmpdir()));

        yield* client.rpc("tools/call", {
          name: "generate_image",
          arguments: { subject: "unused" },
        });
        const path = yield* storedFile(harness.retentionDirectory);
        const file = yield* Effect.promise(() => stat(path));

        const directory = yield* Effect.promise(() =>
          stat(harness.retentionDirectory),
        );

        const temporary = yield* Effect.promise(() => readdir(tmpdir()));

        expect(file.mtimeMs).toBe(420_000);
        expect(file.mode & 0o777).toBe(0o600);
        expect(directory.mode & 0o777).toBe(0o700);
        expect(
          temporary.filter(
            name => name.startsWith("omp-image-") && !before.includes(name),
          ),
        ).toEqual([]);
        yield* TestClock.adjust(59_999);
        expect(
          yield* Effect.promise(() => readdir(harness.retentionDirectory)),
        ).toHaveLength(1);
        yield* TestClock.adjust(1);
        yield* Effect.promise(async () => {
          await expect
            .poll(() => readdir(harness.retentionDirectory))
            .toEqual([]);
        });
      }),
  );

  it.effect(
    "loads retained bytes from disk and rejects missing files without provider access",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const client = yield* harness.connect("2026-07-28");

        const generation = yield* client.rpc("tools/call", {
          name: "generate_image",
          arguments: { subject: "stored" },
        });

        const generated = yield* Schema.decodeUnknownEffect(
          McpSchema.CallToolResult,
        )(generation.envelope.result);

        const reference = generatedReference(generated);
        const path = yield* storedFile(harness.retentionDirectory);

        yield* Effect.promise(() =>
          writeFile(path, Buffer.from("BAUG", "base64")),
        );

        const edit = yield* client.rpc("tools/call", {
          name: "generate_image",
          arguments: { subject: "load bytes", input: [{ path: reference }] },
        });

        expect(
          (yield* Schema.decodeUnknownEffect(McpSchema.CallToolResult)(
            edit.envelope.result,
          )).isError,
        ).not.toBe(true);
        const request = harness.providerRequests[1];

        if (!request) {
          throw new Error("Image edit did not reach the provider");
        }

        expect(yield* Effect.promise(() => request.json())).toMatchObject({
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: expect.any(String) },
                {
                  type: "input_image",
                  image_url: "data:image/webp;base64,BAUG",
                },
              ],
            },
          ],
        });
        yield* Effect.promise(() => rm(path));

        const missing = yield* client.rpc("tools/call", {
          name: "generate_image",
          arguments: { subject: "missing", input: [{ path: reference }] },
        });

        expectUnavailable(
          yield* Schema.decodeUnknownEffect(McpSchema.CallToolResult)(
            missing.envelope.result,
          ),
        );
        expect(harness.networkCalls()).toBe(2);
      }),
  );

  for (const replacement of ["symlink", "directory", "fifo", "hardlink"]) {
    it.effect(
      `rejects a retained ${replacement} without reading its target or contacting the provider`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarnessWithConfig({
            retention: Duration.minutes(1),
          });

          const client = yield* harness.connect("2026-07-28");

          const generation = yield* client.rpc("tools/call", {
            name: "generate_image",
            arguments: { subject: "original" },
          });

          const generated = yield* Schema.decodeUnknownEffect(
            McpSchema.CallToolResult,
          )(generation.envelope.result);

          const reference = generatedReference(generated);
          const path = yield* storedFile(harness.retentionDirectory);
          const target = join(harness.directory, "private-image");

          yield* Effect.promise(async () => {
            await writeFile(target, "private target");
            await utimes(target, 0, 0);
            await rm(path);

            if (replacement === "symlink") {
              await symlink(target, path);
            } else if (replacement === "directory") {
              await mkdir(path);
            } else if (replacement === "fifo") {
              execFileSync("mkfifo", [path]);
            } else {
              await link(target, path);
            }
          });
          yield* harness.restart;
          const restarted = yield* harness.connect("2026-07-28");

          const edit = yield* restarted.rpc("tools/call", {
            name: "generate_image",
            arguments: { subject: "unavailable", input: [{ path: reference }] },
          });

          expectUnavailable(
            yield* Schema.decodeUnknownEffect(McpSchema.CallToolResult)(
              edit.envelope.result,
            ),
          );
          expect(harness.networkCalls()).toBe(1);
          yield* TestClock.adjust("1 minute");
          expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe(
            "private target",
          );
        }),
    );
  }

  it.effect(
    "accepts only complete UUID references and keeps retained files on disposal",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const client = yield* harness.connect("2026-07-28");

        const generation = yield* client.rpc("tools/call", {
          name: "generate_image",
          arguments: { subject: "original" },
        });

        const generated = yield* Schema.decodeUnknownEffect(
          McpSchema.CallToolResult,
        )(generation.envelope.result);

        const reference = generatedReference(generated);

        const files = yield* Effect.promise(() =>
          readdir(harness.retentionDirectory),
        );

        for (const path of [
          reference + "/../../secret",
          reference + ".webp",
          "generated-image:not-a-uuid",
        ]) {
          const response = yield* client.rpc("tools/call", {
            name: "generate_image",
            arguments: { subject: "invalid", input: [{ path }] },
          });

          const result = yield* Schema.decodeUnknownEffect(
            McpSchema.CallToolResult,
          )(response.envelope.result);

          expect(result.isError).toBe(true);
        }

        expect(harness.networkCalls()).toBe(1);
        yield* harness.dispose;
        expect(
          yield* Effect.promise(() => readdir(harness.retentionDirectory)),
        ).toEqual(files);
      }),
  );
});
