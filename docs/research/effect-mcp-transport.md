# Effect MCP transport facts

Research date: 2026-10-10. Factual prerequisites for design interviewing, not an implementation or client-selection decision.

## Versions and evidence boundary

- **Evidence:** reused the earlier Effect investigation, then inspected the published `effect@4.0.2` sources already extracted at `/tmp/effect402/4.0.2/package`. This is the repository's current Effect version. Citations bind to that immutable npm release, not moving Effect main. MCP modules still carry `@stability unstable`. [E1], [E2]
- **Evidence:** OMP installed version 18.8.9; upstream snapshot `fa5ff4a3a977a28b93d025f4cf50f046e019f18c`. Pinned first-party docs were fetched and installed MCP source supplied a cross-check. [O1], [O2], [O3], [O4], [O5]
- **Unknown:** no endpoint or clients were configured/exercised; no real credentials, paid provider request, dependency installation, or service/deployment was used. Source support is not demonstrated end-to-end interoperability.

## Public Effect surface and native image contract

**Evidence:** aggregate imports are `{ Context, Effect, Layer, Schema } from "effect"`, `{ McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai"`, and HTTP modules such as `{ HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"`. Package exports include `./ai` and `./http`, with MCP modules exported from the AI aggregate. Old `@effect/ai` and `effect/unstable/ai` examples are not the published 4.0.2 import contract. [E1], [E2]

**Evidence:** `McpServer.layerHttp` registers a single Streamable HTTP endpoint in an existing `HttpRouter`. Required options: `name`, `version`, `path`, nonempty `protocols`. Optional security/lifecycle knobs: `allowedOrigins`, `allowSessionTermination`. It provides `McpServer` and `McpServerClient`, requires `HttpRouter`, and can fail layer construction with `Cause.IllegalArgumentError`. It does not supply a listening HTTP server or authentication. [E3] (lines 1543–1601)

**Evidence:** `yield* McpServer.McpServer` exposes `addTool({ tool, annotations, handle })`. The descriptor is `McpSchema.Tool`; annotations are `Context.Context<never>`; `handle(payload)` returns an Effect of `McpSchema.CallToolResult | McpSchema.InputRequired`, errors `InternalError | InvalidParams`, with per-request `McpRequestContext` available. Same-name registration replaces an existing tool. Direct registration receives untyped arguments: descriptor `inputSchema` is not itself a general JSON-Schema validator. The core resolves visibility/name, then invokes the registration's handler. Toolkit registration instead has Effect-Schema parameter decoding. [E3] (lines 203–223, 396–447, 1893–1903), [E7] (lines 435–444)

**Evidence:** native tool images are `CallToolResult.content` blocks. `McpSchema.ImageContent` has `type: "image"`, **`data: Uint8Array` in application code** (`Uint8ArrayFromBase64` codec), and `mimeType: string`. Both inspected 2025-11-25 and 2026-07-28 adapters project those bytes to **base64 strings on the wire**. Results also support `isError` and `structuredContent`. The older adapter permits JSON-object structured content; the public schema accepts any JSON. The modern adapter adds dated `resultType: "complete"` and result metadata. [E4] (lines 1352–1368, 1772–1785), [E5] (lines 73–81, 114–116, 315–341), [E6] (lines 123–135, 185–202, 656–666)

**Evidence:** `registerToolkit` serializes its encoded result as JSON **text** plus structured content; an image-shaped JSON object there does not automatically become native image content. Its `toolResultContent` is a text-only mapping. [E3] (lines 1840–1841, 1962–1987)

**Constraint:** `tools/call` carries JSON `arguments`, not an automatic attachment channel. An image-editing tool must define its image argument representation. Native image **output** support proves nothing about automatic forwarding of a user's attached input image. [E4] (lines 1802–1815), [S3]

## Protocol eras and HTTP sessions

**Evidence:** supported adapters are `v2024_11_05`, `v2025_03_26`, `v2025_06_18`, `v2025_11_25`, `v2026_07_28`. `layerHttp` requires the application to supply its adapter list. [E8]

- **2026-07-28:** request-scoped version/capability metadata; no `initialize` handshake, protocol-level MCP session, or GET event stream. Effect checks `MCP-Protocol-Version` against `_meta["io.modelcontextprotocol/protocolVersion"]`, requires client-capabilities metadata, and validates mirrored `Mcp-Method`/routing `Mcp-Name` headers. [E9] (lines 264–321), [S1], [S2]
- **Older revisions:** initialization chooses an exact offered stateful adapter when available, otherwise the **first configured stateful adapter**. That negotiation response does not prove a client accepts an unsupported version. HTTP initialization creates a UUID, returns `Mcp-Session-Id` and selected version; subsequent legacy requests require the id. Negotiated profiles/session ids live in process-local Maps. [E9] (lines 205–210, 446–462, 537–574), [E10] (lines 93–118)
- **Dual era:** modern and appropriate older adapters can coexist. Official compatibility guidance says legacy → modern-only fails, whereas legacy → dual-era works by initialization. There is no legacy-client automatic upgrade to the modern request model. [E9], [S2]

**Session answer:** HTTP intrinsically does **not** need server-side MCP sessions under 2026-07-28. **This Effect implementation does require its in-memory sessions for initialization-based HTTP clients**, with no legacy sessionless option exposed by `layerHttp`. Sessions have no expiry. Optional `allowSessionTermination` permits DELETE, returns 204 for a valid session, interrupts its in-flight requests, and later use gets 404. Without it DELETE is 405; modern-only configurations also return 405. Session ids are not provider credentials or authentication principals; any holder can terminate a session unless surrounding authorization prevents it. [E3] (lines 1563–1574), [E9], [E10]

**Evidence:** Effect's 2024-11-05 HTTP support is a schema compatibility adapter over its **single endpoint**, not historical two-endpoint HTTP+SSE. `layerHttp` does not offer GET SSE, event resumption, or session expiry. GET/PUT/PATCH/OPTIONS return 405. Accepted notification-only POSTs receive 202. Content type must be application/json (415 otherwise); Accept must include both application/json and text/event-stream (406 otherwise). Completed single results may be JSON; in-progress/multiple-message responses become SSE. [E3] (lines 1552–1574, 1631–1671)

## Cancellation, progress, errors, and limits

**Evidence:** legacy HTTP `notifications/cancelled` finds an active request **within its session**, forwards RPC Interrupt, and suppresses the cancelled completion. A sessionless HTTP cancellation notification does not identify another POST's request. The modern spec instead treats closing the request's SSE response stream as cancellation. Effect's underlying HTTP RPC request-scope finalizer sends Interrupt and queues disconnect; RPC disconnect interrupts tracked request fibers. This request-scope finalization is also used with older adapters, so older-spec resumption after disconnect must not be promised. [E3] (lines 1081–1104, 1723–1750), [E11] (lines 164–171, 1110–1153), [S1]

**Evidence:** handlers can emit `notifications/progress` through the McpServer notification client and read the progress token in request metadata. Progress/log notifications with request context are targeted to that request, not broadcast to other clients. Modern progress with a nonmatching token is dropped. HTTP can carry progress before the final result as request-scoped SSE. These mechanisms do not produce meaningful provider progress automatically. [E3] (lines 119–131, 204, 1259–1303, 1661–1667), [E4] (lines 165–166, 915–930)

**Evidence:** `CallToolResult({ isError: true, content: [...] })` is a tool execution result, distinct from a JSON-RPC error. Inspected dated adapters convert core tool-execution/invalid-tool-input failures to isError text results; unknown tools/admission/schema failures take protocol-error paths. Direct `addTool` maps `InternalError` to ToolExecutionError and `InvalidParams` to invalid tool input/continuation. Therefore `Effect.fail(InvalidParams)` here does not universally mean a wire JSON-RPC invalid-params response. Toolkit registration separately catches/scrubs unexpected failures into an internal-tool-error result while interruption propagates. [E3] (lines 419–438, 1880–1927), [E5] (lines 315–341), [E6] (lines 641–667), [S3]

**Evidence:** `layerHttp` exposes no request deadline, image-size, overall response-size, session-count, request-rate, or execution-concurrency option. McpServer constructs RpcServer without a concurrency override; RpcServer defaults to **unbounded**. The HTTP response message queue defaults to 16 chunks, **not** a byte/image-size ceiling. HTTP exposes optional `HttpIncomingMessage.MaxBodySize` (also re-exported by HttpServerRequest), default undefined. Enforcement in a future Bun adapter was **not verified**; the repo's currently installed `@effect` dependency list has no platform-bun adapter. [E3] (lines 1362–1364, 1583–1595, 1615–1616), [E11] (lines 122–129, 1110–1115), [E12]

**Constraint:** request/response admission limits and deadlines need separate application/runtime choices. Interrupting a request does not establish that an already-submitted provider operation stopped, nor that billing was prevented/refunded. Transport progress does not prove deadline extension.

## HTTP security attachment

**Evidence:** `allowedOrigins` is an exact Origin allowlist on `layerHttp`. No Origin is accepted; a present Origin outside the list is 403. Omitting the list rejects every Origin-bearing request, **not** every unauthenticated request. OPTIONS is 405; this is not an out-of-the-box cross-origin browser API. [E3] (lines 1558–1561, 1621–1645, 1789–1794)

**Evidence:** the MCP layer has no bearer-token/authentication option. Authentication attaches to surrounding router/request handling. `HttpRouter.middleware(fn).layer` affects route layers to which it is provided; `HttpRouter.middleware(fn, { global: true })` / `addGlobalMiddleware` affects the router globally. Such middleware can inspect `HttpServerRequest.headers` before admitting the MCP handler. Binding/listening/private-network reachability are outside this MCP layer. Dated HTTP specs require Origin validation and recommend authentication. This identifies a supported seam, not a chosen credential scheme. [E3], [E13] (lines 79–95, 975–1051), [S1], [S4]

**Inference:** private Tailscale reachability is a network/deployment control; it does not make MCP session ids authentication or define a bearer policy. No interface, TLS/proxy, ACL, credentials, or client configuration was changed.

## Current client capabilities

### OMP

**Evidence (18.8.9 / pinned upstream snapshot):** first-party docs explicitly distinguish `type: "http"` Streamable HTTP from legacy `type: "sse"`. HTTP accepts `url` and arbitrary `headers`; managed OAuth injects `Authorization: Bearer …`, while explicit Authorization suppresses URL-keyed fallback. Native config discovery expands `${VAR}` placeholders; runtime header resolution also supports exact-name environment values or `!command`. These are distinct resolution stages, not interchangeable syntaxes. [O1], [O2], [O3]

**Evidence:** client source offers `2025-11-25`, performs `initialize`/`notifications/initialized`, echoes the negotiated protocol version and supplied session id, and tolerates 405 for optional GET SSE. The docs/source preserve MCP image result blocks as agent image content. MCP call input is a JSON object passed as `arguments`; no automatic conversion of user image attachments into server tool arguments was established. [O2], [O3], [O4], [O5], [O6]

**Constraint:** default MCP request timeout is 30 seconds; per-server `timeout` or process-wide `OMP_MCP_TIMEOUT_MS` changes it; zero disables. A long generation can outlast that default. Native image result delivery to the chosen model and an actual input-image workflow remain **unexercised**. Modern-only protocol compatibility is contradicted by this inspected initialization-based source contract. [O1], [O2]

### Codex CLI

**Evidence:** latest published release observed was `rust-v0.162.1` (2026-10-09), commit `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`; live documentation is unversioned, not a minimum-version guarantee. Official docs support Streamable HTTP `url`, `bearer_token_env_var`, static `http_headers`, and `env_http_headers` mapping header names to environment-variable names. CLI source supports `codex mcp add <NAME> --url <URL> --bearer-token-env-var <ENV_VAR>`; `--env` is stdio-only. [C1], [C2], [C3]

**Evidence:** pinned source converts MCP image result blocks into native model `InputImage` items in function-call output. **Non-null `structuredContent` takes precedence: serialized JSON text is used instead, discarding accompanying content images.** Non-image-capable models receive text placeholders; image preparation may resize or reject invalid/oversized input. These are source facts, not exercised interoperability. [C4], [C5], [C6]

**Evidence:** third-party MCP arguments are parsed from the model's JSON text and forwarded; no automatic user-image attachment bridge was established. Path/URL/base64 are ordinary JSON arguments. Special `openai/fileParams` handling is restricted to the host-owned `codex_apps`, not custom MCP servers. [C5] (lines 146–167, 1873–1888)

**Evidence:** default initialization offers **2025-06-18**. The `mcp_2026_07_28` feature is under development/default false; enabled mode prefers 2026-07-28 with legacy 2025-06-18 fallback. Stdio additionally requires `CODEX_MCP_PROTOCOL_VERSION=2026-07-28` for modern mode. The inspected source does not offer 2025-11-25 even though its pinned rmcp SDK knows that revision. Legacy startup source does not compare the server's returned revision with the offered one; subsequent/runtime acceptance is **unverified**, not a compatibility guarantee. Official docs provide no dated supported-version matrix. [C7], [C8], [C9], [C10], [C11]

### Claude Code

**Evidence:** current npm version observed by delegated researcher was `2.1.296`; changelog snapshot `2301018b1f61073c501a8e7a4813ef48c239163b` (2026-10-09). Implementation is not public: these are first-party docs/changelog findings, not bundle inspection. Documentation is unversioned. [A1], [A2]

**Evidence:** `claude mcp add --transport http <name> <url>` and JSON `type: "http"`/`url` configure remote Streamable HTTP (`streamable-http` is an accepted alias). Arbitrary `--header`/`headers` and `headersHelper` are documented. Bearer environment configuration is through `headers: { Authorization: "Bearer ${MY_TOKEN}" }`, not a dedicated bearer-env property. `${VAR}` / `${VAR:-default}` expands in URL/headers, but reserved credential-variable names such as `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are deliberately expanded empty there, even with defaults. [A1], [A3]

**Evidence:** native PNG/JPEG/GIF/WebP tool-result image blocks display inline, possibly resized/compressed. Version 2.1.283 added saving **originals** in session tool-results with a path for Claude; it is not the first-inline-image minimum. Disabling history/session persistence stops file saving, not inline display. Unsupported MIME types are saved/path-referenced instead of inline vision. Native image blocks use raw base64 `data` and required `mimeType`, not a native URL field. HTTP response bodies/SSE events have a 16 MB post-decompression cap, and image results remain subject to MCP output limits. [A1] (Images in tool results), [A2], [A4]

**Evidence:** Agent SDK docs say structured content is forwarded alongside image/resource content blocks (text content blocks excluded); changelog 2.1.128 fixed dropped images when both structured content and content blocks were present. This differs from the inspected Codex behavior. Base64 inside structuredContent remains JSON text, not a native image. [A2], [A4]

**Unknown:** first-party docs/changelog do not guarantee transferring a user's pasted/attached image bytes into arbitrary MCP arguments. User attachments, built-in image reading, and tool-result files are distinct workflows. A server's path/URL/base64 inputSchema fields are ordinary JSON arguments, not automatic native image transfer. [A1], [A5]

**Evidence:** docs explicitly distinguish v1 (MCP TypeScript SDK 1.x) and v2 (SDK 2.0, adding 2026-07-28). V2 probes HTTP/stdio/claude.ai servers for the modern revision, uses it when supported, otherwise connects as v1; remote Anthropic flags can pin individual servers older. V2 selection begins at 2.1.232 with fetched feature flags; it is the default at 2.1.274 when flags were not fetched. `MCP_SDK_GENERATION` and `MCP_PROTOCOL_NEGOTIATION` can override selection. Version alone does not guarantee wire revision. The v1 handshake date/supported-version matrix is **not specified**; a changelog mention of 2025-11-25 URL prompts is not a blanket interoperability guarantee. [A1] (MCP client runtimes), [A2], [A6]

**Shared unknown:** the specific Effect endpoint's handshake, framing/authentication, MIME visibility, large-image behavior, and input-image workflow are untested for all clients. Latest MCP specification, client default protocol, SDK-known revisions, and actual negotiated revision are different facts.

## Constraints for later decisions

1. Use native image content, not JSON text describing an image, if native output is required. Codex currently prioritizes non-null structuredContent over content images, so returning both can hide images from that client.
2. Bind accepted client revisions before promising interoperability; OMP's inspected contract is initialization-based, not modern-only.
3. Older HTTP clients bring Effect's in-process sessions and their cleanup limitations; HTTP itself does not force sessions.
4. Decide deadlines and request/image/concurrency limits independently of protocol transport; progress is not cancellation/billing proof.
5. Define and exercise an input-image JSON argument workflow; output-image support is insufficient.
6. Router auth, Origin checking, and private-network exposure are different mechanisms. These notes choose none of them.

## Sources

[E1]: https://unpkg.com/effect@4.0.2/package.json
[E2]: https://unpkg.com/effect@4.0.2/src/ai/index.ts
[E3]: https://unpkg.com/effect@4.0.2/src/ai/McpServer.ts
[E4]: https://unpkg.com/effect@4.0.2/src/ai/McpSchema.ts
[E5]: https://unpkg.com/effect@4.0.2/src/ai/internal/mcpProtocol/v2025_11_25.ts
[E6]: https://unpkg.com/effect@4.0.2/src/ai/internal/mcpProtocol/v2026_07_28.ts
[E7]: https://unpkg.com/effect@4.0.2/src/ai/internal/mcpCore.ts
[E8]: https://unpkg.com/effect@4.0.2/src/ai/McpProtocol.ts
[E9]: https://unpkg.com/effect@4.0.2/src/ai/internal/mcpRuntime.ts
[E10]: https://unpkg.com/effect@4.0.2/src/ai/internal/mcpStatefulRuntime.ts
[E11]: https://unpkg.com/effect@4.0.2/src/rpc/RpcServer.ts
[E12]: https://unpkg.com/effect@4.0.2/src/http/HttpIncomingMessage.ts
[E13]: https://unpkg.com/effect@4.0.2/src/http/HttpRouter.ts
[O1]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/docs/mcp-config.md
[O2]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/docs/mcp-protocol-transports.md
[O3]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/docs/mcp-server-tool-authoring.md
[O4]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/mcp/types.ts
[O5]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/mcp/tool-bridge.ts
[O6]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/mcp/client.ts
[S1]: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
[S2]: https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
[S3]: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
[S4]: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
[C1]: https://developers.openai.com/codex/mcp#streamable-http-servers
[C2]: https://developers.openai.com/codex/config-reference
[C3]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/cli/src/mcp_cmd.rs#L101-L160
[C4]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/models.rs#L2304-L2440
[C5]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/mcp_tool_call.rs
[C6]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/image_preparation.rs
[C7]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/codex-mcp/src/rmcp_client.rs#L1106-L1129
[C8]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/rmcp-client/src/protocol_mode.rs#L9-L50
[C9]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/features/src/lib.rs
[C10]: https://github.com/modelcontextprotocol/rust-sdk/blob/3e636cab26c013eca5131103c03d20237f12c4df/crates/rmcp/src/service/client.rs#L868-L905
[A1]: https://code.claude.com/docs/en/mcp
[A2]: https://github.com/anthropics/claude-code/blob/2301018b1f61073c501a8e7a4813ef48c239163b/CHANGELOG.md
[A3]: https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson
[A4]: https://code.claude.com/docs/en/agent-sdk/custom-tools
[A5]: https://code.claude.com/docs/en/common-workflows#work-with-images
[A6]: https://code.claude.com/docs/en/env-vars
[C11]: https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/Cargo.toml#L452
