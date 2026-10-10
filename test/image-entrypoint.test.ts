// @effect-diagnostics unstableApiUsage:off
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";

import { Effect, Schema } from "effect";
import { McpSchema } from "effect/ai";
import { describe, expect, it } from "vitest";

import { readMcpResponse } from "./mcp-response.ts";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));

const revision = "2025-11-25";

const Initialization = Schema.Struct({
  result: Schema.Struct({ protocolVersion: Schema.String }),
});

const ListedTools = Schema.Struct({
  result: Schema.Struct({ tools: Schema.Array(McpSchema.Tool) }),
});

const ToolResult = Schema.Struct({ result: McpSchema.CallToolResult });

const startService = async (entrypoint: string, useXdgState = true) => {
  const root = await mkdtemp("/dev/shm/omp-images-entrypoint-");

  try {
    const temporaryDirectory = join(root, "tmp");
    const profileDirectory = join(root, "agent");

    const retentionDirectory = useXdgState
      ? join(root, "state", "omp-images-mcp", "generated")
      : join(root, ".local", "state", "omp-images-mcp", "generated");

    const tokenPath = join(root, "bearer-token");
    const token = `smoke-${randomUUID()}`;

    await mkdir(temporaryDirectory);
    await mkdir(profileDirectory);
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
    await writeFile(
      join(profileDirectory, "config.yml"),
      "modelRoles:\n  default: openai/gpt-5.4\n  image: openai/gpt-image-2\n",
    );

    const settings = await Settings.loadReadOnly({
      agentDir: profileDirectory,
      cwd: root,
    });

    const auth = await discoverAuthStorage(profileDirectory, {
      settings,
      cwd: root,
    });

    try {
      await auth.credentials.set("openai", {
        type: "api_key",
        key: "fake-provider-key",
      });
    } finally {
      auth.close();
    }

    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 404 }),
    });

    const port = listener.port;

    await listener.stop(true);

    const command = [process.execPath, join(projectDirectory, entrypoint)];

    const child = Bun.spawn(command, {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        TMPDIR: temporaryDirectory,
        PI_CODING_AGENT_DIR: profileDirectory,
        OMP_PROFILE: "",
        PI_PROFILE: "",
        PI_CONFIG_DIR: ".omp",
        OMP_CONFIG_DIR: ".omp",
        PI_CONFIG_FILES: "",
        OMP_CONFIG_FILES: "",
        OPENAI_API_KEY: "",
        XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: useXdgState ? join(root, "state") : "",
        XDG_CACHE_HOME: join(root, "cache"),
        OMP_IMAGES_MCP_BEARER_TOKEN_FILE: tokenPath,
        OMP_IMAGES_MCP_PROFILE_DIRECTORY: profileDirectory,
        OMP_IMAGES_MCP_WORKING_DIRECTORY: root,
        OMP_IMAGES_MCP_PORT: String(port),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const endpoint = `http://127.0.0.1:${port}/mcp`;

    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": revision,
    });

    let nextId = 1;

    const post = (method: string, params: Schema.Json = {}) =>
      fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        signal: AbortSignal.timeout(2_000),
      });

    const initialized = () =>
      fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
        signal: AbortSignal.timeout(2_000),
      });

    const ready = async () => {
      const deadline = Date.now() + 10_000;

      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(
            `Entrypoint exited during startup (${child.exitCode}):\n${await stdout}\n${await stderr}`,
          );
        }

        let response: Response;

        try {
          response = await fetch(endpoint, {
            method: "POST",
            body: "not JSON",
            signal: AbortSignal.timeout(500),
          });
        } catch {
          await Bun.sleep(50);

          continue;
        }

        await response.arrayBuffer();

        // Bun binds before HttpRouter finishes installing the application.
        if (response.status !== 404) {
          return response.status;
        }

        await Bun.sleep(50);
      }

      throw new Error("Entrypoint did not listen within 10 seconds");
    };

    const waitForExit = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        return await Promise.race([
          child.exited,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error("Entrypoint did not exit within 5 seconds")),
              5_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    const stop = async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }

      try {
        const exitCode = await waitForExit();

        return { exitCode, stdout: await stdout, stderr: await stderr };
      } catch (error) {
        child.kill("SIGKILL");
        await waitForExit();

        throw error;
      }
    };

    const dispose = async () => {
      try {
        await stop();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };

    return {
      ready,
      post,
      initialized,
      headers,
      stop,
      dispose,
      retentionDirectory,
      tokenPath,
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });

    throw error;
  }
};

describe("Bun service entrypoint", () => {
  it("starts src/main.ts using prefixed environment configuration, serves MCP discovery and exits cleanly on SIGTERM", async () => {
    const service = await startService("src/main.ts");

    try {
      expect((await stat(service.tokenPath)).mode & 0o777).toBe(0o600);
      expect(await service.ready()).toBe(401);

      const initialize = await service.post("initialize", {
        protocolVersion: revision,
        capabilities: {},
        clientInfo: { name: "subprocess-smoke", version: "1" },
      });

      expect(initialize.status).toBe(200);
      expect(
        Schema.decodeUnknownSync(Initialization)(
          await Effect.runPromise(readMcpResponse(initialize)),
        ).result.protocolVersion,
      ).toBe(revision);

      const sessionId = initialize.headers.get("Mcp-Session-Id");

      expect(sessionId).toBeTruthy();
      service.headers.set("Mcp-Session-Id", sessionId ?? "");

      const initialized = await service.initialized();

      expect(initialized.status).toBe(202);
      await initialized.arrayBuffer();

      const listed = await service.post("tools/list");

      expect(listed.status).toBe(200);

      const tools = Schema.decodeUnknownSync(ListedTools)(
        await Effect.runPromise(readMcpResponse(listed)),
      ).result.tools;

      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe("generate_image");

      const stopped = await service.stop();

      expect(stopped).toMatchObject({ exitCode: 0 });
    } finally {
      await service.dispose();
    }
  }, 30_000);

  it.each([true, false])(
    "generates native MCP images using the default retained directory (XDG state: %s) and preserves them on SIGTERM",
    async useXdgState => {
      const service = await startService(
        "test/fixtures/image-entrypoint.ts",
        useXdgState,
      );

      try {
        expect(await service.ready()).toBe(401);

        const initialize = await service.post("initialize", {
          protocolVersion: revision,
          capabilities: {},
          clientInfo: { name: "subprocess-smoke", version: "1" },
        });

        expect(initialize.status).toBe(200);
        await initialize.arrayBuffer();

        const sessionId = initialize.headers.get("Mcp-Session-Id");

        expect(sessionId).toBeTruthy();
        service.headers.set("Mcp-Session-Id", sessionId ?? "");

        const initialized = await service.initialized();

        expect(initialized.status).toBe(202);
        await initialized.arrayBuffer();

        const generated = await service.post("tools/call", {
          name: "generate_image",
          arguments: { subject: "a smoke-test image" },
        });

        expect(generated.status).toBe(200);

        const result = Schema.decodeUnknownSync(ToolResult)(
          await Effect.runPromise(readMcpResponse(generated)),
        ).result;

        expect(result.isError).not.toBe(true);

        const image = result.content.find(block => block.type === "image");

        expect(image).toBeDefined();

        if (!image || image.type !== "image") {
          throw new Error("OMP did not return native MCP image content");
        }

        expect(image.mimeType).toBe("image/png");
        expect(image.data.subarray(0, 8)).toEqual(
          new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        expect(result.content).toContainEqual({
          type: "text",
          text: expect.stringContaining("generated-image:"),
        });

        const retained = (await readdir(service.retentionDirectory)).filter(
          file => file.endsWith(".png"),
        );

        expect(retained).toHaveLength(1);

        for (const file of retained) {
          expect(
            await readFile(join(service.retentionDirectory, file)),
          ).toEqual(Buffer.from(image.data));
        }

        const stopped = await service.stop();

        expect.soft(stopped).toMatchObject({ exitCode: 0 });
        expect(await readdir(service.retentionDirectory)).toEqual(
          expect.arrayContaining(retained),
        );
      } finally {
        await service.dispose();
      }
    },
    30_000,
  );
});
