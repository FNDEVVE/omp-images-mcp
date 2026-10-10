// @effect-diagnostics unstableApiUsage:off
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";

import { Cause, Effect, Exit, Layer, Runtime } from "effect";
import { HttpRouter } from "effect/http";

import { startupConfig, startupEnvironment } from "./image-config.ts";
import * as ImageService from "./image-service.ts";

export const main = (fetch?: FetchImpl) =>
  Effect.gen(function* () {
    const config = yield* startupConfig.parse(startupEnvironment);

    return yield* HttpRouter.serve(ImageService.layer(config, fetch), {
      disableLogger: true,
    }).pipe(
      Layer.provide(
        BunHttpServer.layer({
          hostname: "127.0.0.1",
          port: config.port,
          idleTimeout: 255,
          maxRequestBodySize: config.maxRequestBodyBytes,
          disablePreemptiveShutdown: true,
        }),
      ),
      Layer.launch,
    );
  });

export const run = (fetch?: FetchImpl) => {
  const disposed = Promise.withResolvers<void>();

  // OMP eagerly installs signal handlers; keep their hard exit behind Effect
  // disposal rather than letting it race listener shutdown and auth cleanup.
  const unregister = postmortem.register("image-service", reason =>
    reason === postmortem.Reason.SIGTERM || reason === postmortem.Reason.SIGINT
      ? disposed.promise
      : undefined,
  );

  BunRuntime.runMain(main(fetch), {
    teardown: (exit, onExit) => {
      unregister();
      disposed.resolve();

      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
        onExit(0);
      } else {
        Runtime.defaultTeardown(exit, onExit);
      }
    },
  });
};

if (import.meta.main) {
  run();
}
