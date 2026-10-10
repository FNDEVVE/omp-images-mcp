// @effect-diagnostics unstableApiUsage:off
import type { FetchImpl } from "@oh-my-pi/pi-ai";

import { Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";

import { accessMiddleware } from "./http-access.ts";
import type { StartupConfig } from "./image-config.ts";
import * as ImageRetention from "./image-retention.ts";
import { registerTool } from "./original-tool.ts";

export const layer = (config: StartupConfig, fetch?: FetchImpl) =>
  Layer.merge(
    registerTool(config, fetch).pipe(
      Layer.provideMerge(
        McpServer.layerHttp({
          name: "omp-images-mcp",
          version: "0.0.0",
          path: "/mcp",
          protocols: [
            McpProtocol.v2026_07_28,
            McpProtocol.v2025_11_25,
            McpProtocol.v2025_06_18,
          ],
        }),
      ),
      Layer.provide(ImageRetention.layer(config)),
    ),
    accessMiddleware(config),
  );
