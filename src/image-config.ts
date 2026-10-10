import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils/dirs";

import {
  Config,
  ConfigProvider,
  Duration,
  Effect,
  Redacted,
  Schema,
} from "effect";

const positiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

const usableRetention = Schema.DurationFromString.check(
  Schema.makeFilter(
    duration => Duration.isFinite(duration) && Duration.isPositive(duration),
    {
      expected: "a finite positive retention duration",
    },
  ),
);

const invalidTokenFile = (): never => {
  throw new Error("Invalid bearer token file");
};

export const startupEnvironment = ConfigProvider.fromEnv().pipe(
  ConfigProvider.constantCase,
  ConfigProvider.nested("OMP_IMAGES_MCP"),
);

export const startupConfig = Config.all({
  bearerToken: Config.String("bearerTokenFile").pipe(
    Config.mapEffect(path =>
      Effect.tryPromise({
        try: async () => {
          // Nonblocking open lets us reject special files before reading them.
          const file = await open(
            path,
            constants.O_RDONLY | constants.O_NONBLOCK,
          );

          try {
            const stat = await file.stat();

            if (
              !stat.isFile() ||
              stat.uid !== process.getuid?.() ||
              (stat.mode & 0o077) !== 0
            ) {
              invalidTokenFile();
            }

            const token = (await file.readFile("utf8")).replace(/\r?\n$/, "");

            if (token.trim().length === 0) {
              invalidTokenFile();
            }

            return Redacted.make(token);
          } finally {
            await file.close();
          }
        },
        catch: () =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message:
                "bearerTokenFile must be a readable, nonempty regular file owned by the process user with no group or world permissions",
            }),
          ),
      }),
    ),
  ),
  port: Config.Port("port").pipe(Config.withDefault(4447)),
  maxConcurrentExecutions: Config.schema(
    positiveInteger,
    "maxConcurrentExecutions",
  ).pipe(Config.withDefault(8)),
  maxRequestBodyBytes: Config.schema(
    positiveInteger,
    "maxRequestBodyBytes",
  ).pipe(Config.withDefault(50 * 1024 * 1024)),
  retention: Config.schema(usableRetention, "retention").pipe(
    Config.withDefault(Duration.hours(24)),
  ),
  retentionDirectory: Config.String("retentionDirectory").pipe(
    Config.withDefault(
      join(
        process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
        "omp-images-mcp",
        "generated",
      ),
    ),
  ),
  profileDirectory: Config.String("profileDirectory").pipe(
    Config.withDefault(getAgentDir()),
  ),
  workingDirectory: Config.String("workingDirectory").pipe(
    Config.withDefault(getProjectDir()),
  ),
});

export type StartupConfig = Config.Success<typeof startupConfig>;
