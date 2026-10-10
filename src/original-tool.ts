import { join } from "node:path";
// @effect-diagnostics unstableApiUsage:off
import { fileURLToPath } from "node:url";

import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveModelFromSettings } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
  imageGenSchema,
  imageGenTool,
} from "@oh-my-pi/pi-coding-agent/tools/image-gen";

import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
  Semaphore,
} from "effect";
import { McpSchema, McpServer } from "effect/ai";

import type { StartupConfig } from "./image-config.ts";
import {
  ImageExecutionFailed,
  InvalidToolInput,
  StartupError,
} from "./image-errors.ts";
import { type RetainedImageStore, RetentionStore } from "./image-retention.ts";
import {
  markToolSuccess,
  recordToolPayload,
  recordToolResult,
  redactImageData,
} from "./request-logging.ts";

const jsonObject = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Json),
);

const remoteInputSchema = () => {
  const original = jsonObject(
    imageGenSchema.toJsonSchema({
      io: "input",
      target: "draft-2020-12",
      dialect: null,
    }),
  );

  const properties = jsonObject(original.properties);
  const input = jsonObject(properties.input);
  const items = jsonObject(input.items);
  const inputProperties = jsonObject(items.properties);
  const path = jsonObject(inputProperties.path);

  return {
    ...original,
    properties: {
      ...properties,
      input: {
        ...input,
        items: {
          ...items,
          properties: {
            ...inputProperties,
            path: {
              ...path,
              description:
                "generated image reference only; host paths are not accepted",
            },
          },
        },
      },
    },
  };
};

const tool = Schema.decodeUnknownSync(McpSchema.Tool)({
  name: imageGenTool.name,
  description: imageGenTool.description,
  inputSchema: remoteInputSchema(),
});

const originalToolSource = fileURLToPath(
  import.meta.resolve("@oh-my-pi/pi-coding-agent/tools/image-gen"),
);

const executionFailure = (cause: unknown, providerStarted: boolean) => {
  // OMP 18.8.9 has no argument-error class. Its argument checks throw plain
  // Error directly in image-gen.ts before generateImage reaches fetch. Require
  // both boundaries: credential/transport errors originate elsewhere, and
  // exhausted model chains are AggregateError. Source changes fail closed.
  if (
    !providerStarted &&
    Predicate.isError(cause) &&
    cause.name === "Error" &&
    cause.stack?.split("\n")[1]?.includes(originalToolSource + ":")
  ) {
    return new InvalidToolInput({ message: cause.message });
  }

  return new ImageExecutionFailed();
};

const toMcpResult = (
  result: Awaited<ReturnType<typeof imageGenTool.execute>>,
  store: RetainedImageStore,
  createdAt: number,
) =>
  Effect.gen(function* () {
    const content: McpSchema.ContentBlock[] = [];
    const references = new Map<string, string>();

    for (const [index, image] of (result.details?.images ?? []).entries()) {
      const outputPath = result.details?.imagePaths[index];

      if (outputPath === undefined) {
        return yield* new ImageExecutionFailed();
      }

      const reference = yield* store.retainImage({
        path: outputPath,
        mimeType: image.mimeType,
        createdAt,
      });

      references.set(outputPath, reference);
      content.push({
        type: "image",
        data: Buffer.from(image.data, "base64"),
        mimeType: image.mimeType,
      });
    }

    for (const block of result.content) {
      if (block.type === "text") {
        let text = block.text;

        for (const [outputPath, reference] of references) {
          text = text.replaceAll(outputPath, reference);
        }

        content.push({ type: "text", text });
      }
    }

    return new McpSchema.CallToolResult({ content });
  });

export const registerTool = (config: StartupConfig, fetch?: FetchImpl) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const settings = yield* Effect.tryPromise({
        try: () =>
          Settings.loadReadOnly({
            agentDir: config.profileDirectory,
            cwd: config.workingDirectory,
          }),
        catch: () =>
          new StartupError({ message: "Failed to load OMP settings." }),
      });

      const auth = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            discoverAuthStorage(config.profileDirectory, {
              settings,
              cwd: config.workingDirectory,
            }),
          catch: () =>
            new StartupError({ message: "Failed to load OMP authentication." }),
        }),
        auth => Effect.sync(() => auth.close()),
      );

      const providerFetch = fetch ?? globalThis.fetch;

      const modelRegistry = yield* Effect.try({
        try: () =>
          new ModelRegistry(auth, join(config.profileDirectory, "models.yml"), {
            settings,
            fetch: providerFetch,
          }),
        catch: () =>
          new StartupError({ message: "Failed to load OMP model registry." }),
      });

      const model = resolveModelFromSettings({
        settings,
        availableModels: modelRegistry.getAvailable(),
      });

      const sessionManager = SessionManager.inMemory(config.workingDirectory);
      const store = yield* RetentionStore;
      const server = yield* McpServer.McpServer;
      const executions = yield* Semaphore.make(config.maxConcurrentExecutions);

      yield* server.addTool({
        tool,
        annotations: Context.empty(),
        handle: payload =>
          Effect.gen(function* () {
            yield* recordToolPayload(payload);

            return yield* Effect.gen(function* () {
              const params = yield* Effect.try({
                try: () => imageGenSchema.assert(payload),
                catch: error =>
                  new InvalidToolInput({
                    message: Predicate.isError(error)
                      ? error.message
                      : String(error),
                  }),
              });

              const input =
                params.input === undefined
                  ? undefined
                  : yield* Effect.forEach(
                      params.input,
                      reference =>
                        Effect.gen(function* () {
                          if (reference.path === undefined) {
                            return reference;
                          }

                          const image = yield* store.resolve(reference.path);

                          yield* redactImageData(image.data);

                          return image;
                        }),
                      { concurrency: "unbounded" },
                    );

              const resolvedParams =
                input === undefined ? params : { ...params, input };

              const abort = new AbortController();
              let providerStarted = false;

              const trackedFetch: FetchImpl = (request, init) => {
                providerStarted = true;

                return providerFetch(request, init);
              };

              const result = yield* Effect.tryPromise({
                try: signal =>
                  imageGenTool.execute(
                    crypto.randomUUID(),
                    resolvedParams,
                    undefined,
                    {
                      sessionManager,
                      modelRegistry,
                      model,
                      settings,
                      fetch: trackedFetch,
                      // No agent loop or message queue exists in this headless context.
                      isIdle: () => true,
                      hasQueuedMessages: () => false,
                      abort: () => abort.abort(),
                    },
                    AbortSignal.any([signal, abort.signal]),
                  ),
                catch: error => executionFailure(error, providerStarted),
              });

              const createdAt = yield* Clock.currentTimeMillis;

              yield* recordToolResult(result);

              const adapted = yield* toMcpResult(result, store, createdAt);

              yield* markToolSuccess;

              return adapted;
            }).pipe(
              Effect.catchTags({
                InvalidToolInput: error =>
                  Effect.fail(
                    new McpSchema.InvalidParams({
                      message: "Invalid tool input: " + error.message,
                    }),
                  ),
                ImageExecutionFailed: error =>
                  Effect.succeed(
                    new McpSchema.CallToolResult({
                      isError: true,
                      content: [{ type: "text", text: error.message }],
                    }),
                  ),
              }),
              executions.withPermitsIfAvailable(1),
              Effect.map(
                Option.getOrElse(
                  () =>
                    new McpSchema.CallToolResult({
                      isError: true,
                      content: [
                        {
                          type: "text",
                          text:
                            "Image execution capacity reached (" +
                            config.maxConcurrentExecutions +
                            " concurrent requests). Try again after an active request finishes.",
                        },
                      ],
                    }),
                ),
              ),
            );
          }),
      });
    }),
  );
