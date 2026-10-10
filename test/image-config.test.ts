// @effect-diagnostics unstableApiUsage:off
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  Config,
  ConfigProvider,
  Duration,
  Effect,
  Logger,
  Redacted,
} from "effect";

import { startupConfig } from "../src/image-config.ts";

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "omp-images-token-"))),
  directory =>
    Effect.promise(() => rm(directory, { recursive: true, force: true })),
);

const makeTokenFile = (contents: string, mode = 0o600) =>
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const path = join(directory, "bearer-token");

    yield* Effect.promise(async () => {
      await writeFile(path, contents, { mode: 0o600 });
      await chmod(path, mode);
    });

    return path;
  });

// Startup configuration is the consumer seam for the Bun listener.
describe("image service startup configuration", () => {
  it.effect("loads a private token file and removes its trailing newline", () =>
    Effect.gen(function* () {
      const bearerTokenFile = yield* makeTokenFile("file-secret\n");

      const config = yield* startupConfig.parse(
        ConfigProvider.fromUnknown({ bearerTokenFile }),
      );

      expect(Redacted.value(config.bearerToken)).toBe("file-secret");
    }),
  );

  for (const invalid of [
    { bearerTokenFile: undefined },
    { bearerTokenFile: "" },
    { port: 0 },
    { port: 65536 },
    { maxConcurrentExecutions: 0 },
    { maxConcurrentExecutions: 1.5 },
    { maxRequestBodyBytes: -1 },
    { retention: "not a duration" },
    { retention: "0 seconds" },
    { retention: "-1 second" },
    { retention: "Infinity" },
  ]) {
    it.effect(
      "rejects invalid startup config: " + JSON.stringify(invalid),
      () =>
        Effect.gen(function* () {
          const bearerTokenFile = yield* makeTokenFile("test-secret");

          const result = yield* Effect.result(
            startupConfig.parse(
              ConfigProvider.fromUnknown(
                { bearerTokenFile, ...invalid },
                { preserveEmptyStrings: true },
              ),
            ),
          );

          expect(result._tag).toBe("Failure");
        }),
    );
  }

  it.effect("loads overrides through the same config provider", () =>
    Effect.gen(function* () {
      const bearerTokenFile = yield* makeTokenFile("override-secret");

      const config = yield* startupConfig.parse(
        ConfigProvider.fromUnknown({
          bearerTokenFile,
          port: "5555",
          maxConcurrentExecutions: "2",
          maxRequestBodyBytes: "1024",
          retention: "1 minute",
          profileDirectory: "/isolated/profile",
          workingDirectory: "/isolated/work",
          retentionDirectory: "/isolated/retained",
        }),
      );

      expect(config.port).toBe(5555);
      expect(config.maxConcurrentExecutions).toBe(2);
      expect(config.maxRequestBodyBytes).toBe(1024);
      expect(Duration.toMillis(config.retention)).toBe(60_000);
      expect(config.profileDirectory).toBe("/isolated/profile");
      expect(config.workingDirectory).toBe("/isolated/work");
      expect(config.retentionDirectory).toBe("/isolated/retained");
      expect(Redacted.value(config.bearerToken)).toBe("override-secret");
    }),
  );

  it.effect("loads defaults and keeps the required bearer token redacted", () =>
    Effect.gen(function* () {
      const bearerTokenFile = yield* makeTokenFile("startup-secret");

      const config = yield* startupConfig.parse(
        ConfigProvider.fromUnknown({ bearerTokenFile }),
      );

      expect(config.port).toBe(4447);
      expect(config.maxConcurrentExecutions).toBe(8);
      expect(config.maxRequestBodyBytes).toBe(52_428_800);
      expect(Duration.toMillis(config.retention)).toBe(86_400_000);
      expect(config.profileDirectory).toBe(process.env.PI_CODING_AGENT_DIR);
      expect(config.workingDirectory).toBe(process.cwd());
      expect(config.retentionDirectory).toBe(
        `${process.env.XDG_STATE_HOME}/omp-images-mcp/generated`,
      );
      expect(Redacted.isRedacted(config.bearerToken)).toBe(true);
      expect(Redacted.value(config.bearerToken)).toBe("startup-secret");
      expect(String(config.bearerToken)).not.toContain("startup-secret");
      expect(JSON.stringify(config)).not.toContain("startup-secret");
      const logs: unknown[] = [];

      const logger = Logger.make(options => {
        logs.push(Logger.formatStructured.log(options));
      });

      yield* Effect.logInfo(config).pipe(
        Effect.provide(Logger.layer([logger])),
      );

      expect(logs).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain("startup-secret");
    }),
  );

  it.effect("requires a token file rather than a plaintext bearer token", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        startupConfig.parse(
          ConfigProvider.fromUnknown({ bearerToken: "plaintext-secret" }),
        ),
      );

      expect(error).toBeInstanceOf(Config.ConfigError);
      expect(JSON.stringify(error)).not.toContain("plaintext-secret");
    }),
  );

  for (const special of ["missing", "directory"]) {
    it.effect(
      "rejects a " + special + " token file without OS error causes",
      () =>
        Effect.gen(function* () {
          const directory = yield* temporaryDirectory;

          const bearerTokenFile =
            special === "missing"
              ? join(directory, "missing-token")
              : directory;

          const error = yield* Effect.flip(
            startupConfig.parse(
              ConfigProvider.fromUnknown({ bearerTokenFile }),
            ),
          );

          expect(error).toBeInstanceOf(Config.ConfigError);
          expect(error.cause).toBeInstanceOf(ConfigProvider.SourceError);
          expect(error.cause).not.toHaveProperty("cause");
          expect(String(error)).not.toContain(bearerTokenFile);
          expect(JSON.stringify(error)).not.toContain(bearerTokenFile);
          expect(JSON.stringify(error)).not.toContain("ENOENT");
        }),
    );
  }

  for (const fixture of [
    { name: "empty", contents: "", mode: 0o600 },
    { name: "whitespace-only", contents: " \t\r\n", mode: 0o600 },
    { name: "group-readable", contents: "private-secret", mode: 0o640 },
    { name: "group-writable", contents: "private-secret", mode: 0o620 },
    { name: "group-executable", contents: "private-secret", mode: 0o610 },
    { name: "world-readable", contents: "private-secret", mode: 0o604 },
    { name: "world-writable", contents: "private-secret", mode: 0o602 },
    { name: "world-executable", contents: "private-secret", mode: 0o601 },
  ]) {
    it.effect(
      "rejects a " + fixture.name + " token file without leaking secrets",
      () =>
        Effect.gen(function* () {
          const bearerTokenFile = yield* makeTokenFile(
            fixture.contents,
            fixture.mode,
          );

          const error = yield* Effect.flip(
            startupConfig.parse(
              ConfigProvider.fromUnknown({ bearerTokenFile }),
            ),
          );

          expect(error).toBeInstanceOf(Config.ConfigError);
          expect(error.cause).toBeInstanceOf(ConfigProvider.SourceError);
          expect(error.cause).not.toHaveProperty("cause");
          expect(String(error)).not.toContain("private-secret");
          expect(JSON.stringify(error)).not.toContain("private-secret");
        }),
    );
  }
});
