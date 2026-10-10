# How Effect tests its MCP server (effect 4.0.2)

Research date: 2026-10-10. Facts only; no design decisions. Companion to `effect-mcp-transport.md` (not repeated here).

## Source pinning and evidence boundary

- **Evidence:** the published `effect@4.0.2` `package.json` names `https://github.com/Effect-TS/effect.git`, directory `packages/effect` (`gitHead` is null). The repository has tag `effect@4.0.2` → commit `269a7c864351231d42e6e95b7fa8f32050df3691` ("Version Packages (#8744)", 2026-10-07). `Effect-TS/effect-smol` has no `effect@4.0.2` tag (404); its last push was 2026-07-14. All test citations below point at the `Effect-TS/effect` commit. [R1], [R2]
- **Evidence:** at that commit, `src/ai/McpSchema.ts` and `src/ai/internal/mcpRuntime.ts` are byte-identical to the npm tarball. `McpServer.ts` and `http/HttpRouter.ts` differ only by JSDoc copied onto overloads in the published build (checked with `diff`). The tests exercise the same code that was published.
- **Evidence:** the test sources are **not** in the npm tarball. The harness files under `test/ai/McpServer/TestUtils` and `McpConformance/` are repository-only and cannot be imported from a dependency.
- **Not done:** no tests were run, and nothing was installed into this repo. Statements about runtime behavior come from test assertions, not from observed runs.

## Test inventory (`packages/effect/test/ai/`)

| File                                                                                                     | Role                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `McpServer/v2024_11_05.test.ts`, `v2025_03_26`, `v2025_06_18`, `v2025_11_25`, `v2026_07_28.test.ts`      | Per-revision entrypoints. Each builds `McpConformance.layer(protocol)` and calls the shared suites (`LifecycleTest.suite`, `ToolsTest.suite`, `TransportsTest.suite`/`statelessModernSuite`, …). July 2026 also has inline modern-only tests. [T1], [T2], [T3]                                                  |
| `McpServer/McpConformance/*Test.ts` (13 suites)                                                          | Spec-organized suites: BaseProtocol, Lifecycle, Transports, Utilities, Tools, Resources, Prompts, Completion, Logging, Roots, Sampling, Elicitation, MultiRoundTrip, Subscriptions. Files lack the `.test.ts` suffix and are not collected directly (vitest `include: ["test/**/*.test.{ts,tsx}"]`). [T4], [C1] |
| `McpServer/McpConformance/McpConformance.ts`                                                             | `McpConformance` service and layer: two HTTP harnesses (a bare server and a "features" server) with request builders that are aware of the protocol revision. [T5]                                                                                                                                              |
| `McpServer/McpConformance/McpConformanceFixtures.ts`                                                     | Feature server: Toolkit tools, raw `addTool` content tools (Image/Audio/Resource/Error/Defect), resources, prompts. [T6]                                                                                                                                                                                        |
| `McpServer/McpConformance/McpTestPeer.ts`                                                                | Fake client for server→client (reverse) requests, built on `RpcClient.Protocol.make`. [T7]                                                                                                                                                                                                                      |
| `McpServer/TestUtils/McpHttpHarness.ts`, `McpHttpResponse.ts`, `McpServerLayer.ts`, `McpStdioHarness.ts` | Shared harnesses (described below). [T8]–[T11]                                                                                                                                                                                                                                                                  |
| `McpServer/McpServer.test.ts` (3157 lines)                                                               | Implementation-specific behavior: HTTP disconnect, sessions/DELETE, Origin, CORS/202, mixed-era HTTP, Toolkit errors, direct service calls, custom `RpcServer.Protocol` transports. [T12]                                                                                                                       |
| `McpServer/ProtocolAdapters.test.ts`                                                                     | One `layerHttp` server listing all five adapters; checks wire projections for each revision (images, binary, error mapping). [T13]                                                                                                                                                                              |
| `McpServer/McpProtocol.test.ts`                                                                          | Unit tests of the internal registry/runtime with synthetic adapters. [T14]                                                                                                                                                                                                                                      |
| `McpSchema.test.ts`, `typetest/ai/McpServer.tst.ts`                                                      | Schema and type tests.                                                                                                                                                                                                                                                                                          |

## Seams the tests drive

1. **In-process Fetch handler. This is the dominant HTTP seam.** `makeHttpHarness` passes the app layer, which requires `HttpRouter`, to **`HttpRouter.toWebHandler(appLayer, { disableLogger: true })`**. It then calls `handler(new Request("http://localhost/mcp", …))` directly. No socket is opened. It registers `dispose()` as a scope finalizer. [T8] L10–66

   ```ts
   const { dispose, handler } = HttpRouter.toWebHandler(appLayer, {
     disableLogger: true,
   });
   yield * Effect.addFinalizer(() => Effect.promise(() => dispose()));
   const post = (body: unknown, headers?: HeadersInit) =>
     postText(JSON.stringify(body), headers);
   ```

   The harness also exposes a `fetch` shim that captures and replays `Mcp-Session-Id` / `Mcp-Protocol-Version` from responses, plus `delete(headers)` and a `responses` log. [T8] L23–37

2. **Raw JSON-RPC over HTTP.** Nearly all conformance and adapter tests POST hand-built JSON-RPC objects and decode them with Effect Schemas (`McpSchema.CallToolResult`, `McpSchema.McpError`). They do not use a typed MCP client. [T5], [T13] L614–723
3. **Effect `RpcClient` over the same handler.** Some `McpServer.test.ts` cases use `RpcClient.make(McpSchema.ClientRpcs)` with `RpcClient.layerProtocolHttp({ url: "http://localhost/mcp" })`, `RpcSerialization.layerJsonRpc()` and `FetchHttpClient.layer`. **`FetchHttpClient.Fetch` is replaced with `harness.fetch`**, which sends Effect's `HttpClient` into the in-process handler. [T12] L174–200

   ```ts
   (Layer.provideMerge([
     FetchHttpClient.layer,
     RpcSerialization.layerJsonRpc(),
   ]),
     Layer.provide(Layer.succeed(FetchHttpClient.Fetch, harness.fetch)));
   ```

   **Evidence:** 4.0.2 has no public `McpClient` module. `McpSchema.ClientRpcs` is the exported RPC group used here. [E1] L3187

4. **In-memory stdio.** `makeMcpStdioHarness` wires `McpServer.layerStdio` to `Stdio.layerTest({ stdin: Stream.fromQueue(…), stdout: () => Sink.forEach(…) })`. It parses newline-delimited frames and correlates responses by id. [T11] L90–109
5. **Custom `RpcServer.Protocol` / internal core.** Some tests build `McpServer.layer(...)` over `Layer.succeed(RpcServer.Protocol, transport)`, or call `effect/ai/internal/mcpCore` handlers directly, to test backpressure and isolation. [T12] L849–1110, L2612–2911
6. **Real sockets: none.** The MCP tests contain no `@effect/platform-*`, `BunHttpServer`, `NodeHttpServer`, or `port: 0`. A socket-based pattern exists elsewhere in the repo: `BunHttpServer.layerTest` plus `HttpClient`, used under `it.live`. [T15], [T16]

## Server-layer construction

- **Test helper.** `makeServerLayer` wraps `McpServer.layerHttp({ name, version, path: "/mcp", protocols: options.protocols ?? [McpProtocol.v2025_06_18], allowedOrigins: ["https://allowed.example"], extensions, allowSessionTermination })`. It installs a no-op logger through `Layer.provideMerge(Layer.succeed(References.CurrentLoggers, new Set([noopLogger])))`. **Quirk (evidence):** the helper accepts an `allowedOrigins` option but ignores it. The allowlist is always hard-coded to `https://allowed.example`. [T10] L11–39
- **Registrations.** Tools are registered with `Layer.effectDiscard(McpServer.McpServer.use((server) => server.addTool({...})))` or `McpServer.toolkit(Toolkit)` plus `Toolkit.toLayer(handlers)`. These layers are combined with `.pipe(Layer.provideMerge(makeServerLayer(...)))`, or `Layer.mergeAll(...).pipe(Layer.provide(makeServerLayer(...)))` for the features server. [T12] L566–583, [T6] L463–554
- **Custom router middleware.** `makeHttpHarness(serverLayer, { routerLayer })` merges an extra `Layer<never, never, HttpRouter>` such as `HttpRouter.cors()`, which is `middleware(HttpMiddleware.cors(options), { global: true })`. The 202 test then asserts `access-control-allow-origin: "*"` on the MCP response. This shows that a global router middleware wraps the `layerHttp` route under `toWebHandler`. [T8] L16, [T12] L2355–2392, [E2] L1253–1269
- **Raw router routes.** One test bypasses McpServer. It adds `router.add("POST", "/mcp", () => httpEffect)` from `RpcServer.makeProtocolWithHttpEffect()` over `HttpRouter.layer` and runs it through the same harness. [T12] L2394–2440

## Requests for each protocol revision

- **Stateful revisions (≤ 2025-11-25).** `initializeHttpSession(harness, adapter)` POSTs `initialize` with `protocolVersion: adapter.protocolVersion`. It asserts a non-null `Mcp-Session-Id`, then POSTs `notifications/initialized` and returns `{ "Mcp-Session-Id", "Mcp-Protocol-Version" }` for later calls. [T8] L68–89
- **Sessionless 2026-07-28.** `McpConformance.initialize` sends `server/discover` instead of `initialize` and returns `sessionId: null`. [T5] L262–290. `statelessBody` adds `_meta` keys to each request:
  - `io.modelcontextprotocol/protocolVersion`
  - `…/clientCapabilities` (default `{ elicitation: { form: {} }, roots: {}, sampling: {} }`)
  - `…/clientInfo`

  `statelessHeaders` adds `MCP-Protocol-Version`, `Mcp-Method` and, for `tools/call` / `prompts/get` / `resources/read`, `Mcp-Name`. [T5] L54–115

  ```ts
  "MCP-Protocol-Version": protocol.protocolVersion,
  "Mcp-Method": body.method,
  ...(typeof name === "string" ? { "Mcp-Name": name } : {})
  ```

- **July-only assertions:**
  - Without discovery or a session, two `tools/list` requests both return 200 and no session header; a supplied `Mcp-Session-Id` is ignored. [T3] L117–129
  - `initialize` returns **HTTP 404** with JSON-RPC METHOD_NOT_FOUND. [T3] L131–139
  - Missing or mismatched headers return 400 with `HEADER_MISMATCH_ERROR_CODE`. [T3] L158–180, L277–302
  - An unsupported request version returns 400 with code `-32022`. [T3] L305–326
  - Missing required `_meta` returns 400 INVALID_PARAMS. [T3] L357–386
- **Dual-era.** One handler is built from `makeServerLayer({ protocols: [v2026_07_28, v2025_11_25] })`. A legacy client initializes a session while modern POSTs (`mcp-method` / `mcp-name` headers plus `_meta`) run alongside it. The test asserts that request notifications stay isolated. [T12] L764–847
- **Negotiation.** If the server only lists `v2025_11_25`, an `initialize` offering 2025-06-18 gets 200 with header `mcp-protocol-version: 2025-11-25`. [T12] L1487–1501

## What the tests assert

### Tool results and image content

- **Image fixture.** The fixture registers `ImageTool` through raw `server.addTool`, returning `new McpSchema.CallToolResult({ content: [{ type: "image", data: new Uint8Array([1, 2, 3]), mimeType: "image/png" }] })`. [T6] L92–101
- **Image wire assertion.** For every revision entrypoint, including 2026-07-28, `ToolsTest.suite` asserts this **wire** content [T4] L217–225:

  ```ts
  assert.deepStrictEqual(result.result.content, [
    { type: "image", data: "AQID", mimeType: "image/png" },
  ]);
  ```

  `ProtocolAdapters.test.ts` repeats the base64 `"AQID"` check for 2024-11-05, 2025-03-26 and 2025-06-18 on one multi-adapter server. Embedded resource blobs become `"BwgJ"`. [T13] L1696–1718

- **Decode path.** The tests decode results with `Schema.decodeUnknownEffect(McpSchema.CallToolResult)`. For image checks they compare the raw `result` record (`callToolWire`) rather than the decoded `Uint8Array`. [T4] L16–54
- **Text results differ in 2026-07-28.** Toolkit string results there come back as `JSON.stringify(text)` (mirrored structured content). [T4] L56–60

### Errors

- **Explicit isError results.** A `CallToolResult({ isError: true, content: [...] })` round-trips as `isError: true`. It is distinct from an unknown tool, which returns a JSON-RPC error with `INVALID_PARAMS_ERROR_CODE`. [T4] L176–195, L246–269
- **Defects.** `handle: () => Effect.die("private defect details")` produces a JSON-RPC error `INTERNAL_ERROR_CODE`, message `"Internal error"`, and the details are not leaked. [T6] L131–138, [T4] L271–287
- **`addTool` with `Effect.fail(new McpSchema.InternalError({ message }))`.** Behavior depends on the revision:

  | Revision                           | Result                                                                     |
  | ---------------------------------- | -------------------------------------------------------------------------- |
  | 2025-11-25                         | `isError: true` with text `"database unavailable"`                         |
  | 2025-06-18, 2025-03-26, 2024-11-05 | JSON-RPC error `INTERNAL_ERROR_CODE` with message `"database unavailable"` |

  This refines the error note in `effect-mcp-transport.md`. No 2026-07-28 assertion for this case was found. [T13] L1966–1984

- **Toolkit argument validation:**

  | Revision     | Result                  |
  | ------------ | ----------------------- |
  | ≤ 2025-06-18 | JSON-RPC INVALID_PARAMS |
  | 2025-11-25+  | `isError` text result   |

  In both cases the handler is not invoked (an `observations.toolInvocations` counter checks this). [T4] L345–382

### Cancellation

- **Legacy HTTP.**
  - POSTing `notifications/cancelled` with the session headers returns 202. The tool's `Effect.onInterrupt` resolves a `Deferred`, and the cancelled SSE stream drains to `[]`.
  - The same request id in another session is unaffected.
  - If the request is cancelled before any output, the pending POST body is `""`.

  [T17] L344–440

- **HTTP response disconnect.** Under v2025_03_26, `makeMcpSseReader(response).cancel` (`reader.cancel()` on the Web `Response` body) interrupts the tool. The test comment calls this an implementation property, "not an MCP conformance requirement". [T12] L565–596
- **Modern 2026-07-28 cancellation** is asserted over **stdio** (`startRequest` then `notifications/cancelled`, interrupt observed, later request still served). Over HTTP the only assertion is that a cancellation notification returns 202 with an empty body. No HTTP stream-close test for 2026-07-28 was found (`grep` for `.cancel` call sites returned only the 2025-03-26 test and a stdio subscription). [T17] L239–291, [T3] L141–152
- **DELETE.** Requires `allowSessionTermination: true`. It interrupts an in-flight tool and the pending POST gets 404. The test synchronizes with `Deferred` plus `Effect.forkScoped` and `Fiber.join`. [T12] L2264–2298

### Origin

- **Allowlist.** With no Origin the request gets 200; `origin: https://allowed.example` gets 200; `https://attacker.example` gets **403 for POST, GET, PUT, PATCH, DELETE, HEAD and OPTIONS**. Both legacy and stateless suites assert this. [T18] L445–465, L602–613
- **Default.** A browser Origin is rejected (403) while a client without Origin is accepted. [T12] L1432–1453
- **DELETE.** A disallowed Origin on DELETE returns 403 and leaves the session alive. [T12] L2208–2219
- **Media types and methods.** Content-Type other than JSON returns 415. `Accept` missing either `application/json` or `text/event-stream` (including `*/*`) returns 406. GET/PUT/PATCH/HEAD return 405 with `allow: POST`. [T18] L556–599

### Response reading

`readMcpHttpResponse` branches on `content-type`: JSON uses `response.json()`, while SSE takes the last `data:` line. `makeMcpSseReader` reads events incrementally with `take` / `drain` / `cancel`. [T9] L5–65

## Vitest usage (`@effect/vitest`)

- **`it.effect` everywhere.** Imports are `import { assert, describe, it } from "@effect/vitest"`; ad-hoc helpers are `Effect.fnUntraced` generators. `it.effect` "runs a scoped Effect test with test clock and console services". [T12] L1, [V1] L220–227
- **`it.layer(layer)(name, (it) => …)`** wraps every conformance suite. The layer is **built once per block and cached** (`Layer.buildWithMemoMap(...).pipe(Effect.cached)`). Each test reruns `initialize`, but the HTTP handlers are shared. [T4] L63, [V1] L288–299, [V2] L264–273
- **`excludeTestServices: true`.** This option drops TestClock/TestConsole for a layer block. `UtilitiesTest.statefulLegacySuite` uses it where tests depend on real-time `Effect.timeout("1 second")`. [T17] L309, [V2] L264–267
- **TestClock.**
  - Negative "no message arrives" checks fork `takeMessage.pipe(Effect.timeoutOption("1 millis"))`, call `TestClock.adjust("1 millis")`, then assert `Option.isNone`. [T19] L128–131
  - A reverse-client cache-expiry test calls `TestClock.adjust("11 seconds")`. [T12] L557–561
- **`it.live`.** Not used in the MCP tests. It is used for the Bun socket tests. [T16]
- **Repo config.** `sequence: { concurrent: true }` makes tests within a file run concurrently by default. CI runs the suite under Node, Deno and Bun 1.4.0 (`bun run --bun vitest run`). The `effect` project's Bun exclusion list does not include MCP tests. [C1] L74–76, [C2]
- **npm.** `@effect/vitest@4.0.2` exists with peers `effect ^4.0.2`, `vitest >=5.0.0 <6.0.0`. [R3]

## Reusable seam for a downstream MCP HTTP server

These are public 4.0.2 APIs that the upstream tests rely on or that the repository provides for testing.

- **`HttpRouter.toWebHandler(appLayer, { disableLogger?, middleware?, routerConfig?, memoMap? })`** (public, `@stability unstable`):
  - Returns `{ handler(request, context?) => Promise<Response>, dispose() }`.
  - Accepts any layer requiring `HttpRouter`, such as `McpServer.layerHttp(...)` plus registration and middleware layers.
  - The layer is built immediately; early requests wait for the build.

  This is the in-process seam used by every upstream MCP HTTP test. [E2] L1399–1480, [T8]

- **Global router middleware composes under that seam.** Evidence comes from `HttpRouter.cors()`, which is defined as `HttpRouter.middleware(…, { global: true })`. [INFERENCE] A bearer-checking `HttpRouter.middleware(fn, { global: true })` layer merged into the app layer would wrap the MCP route the same way, but no upstream MCP test exercises authentication. [T12] L2355–2392, [E2] L1260–1269
- **Effect `HttpClient` into the handler.** Provide `Layer.succeed(FetchHttpClient.Fetch, fetchShim)` with `FetchHttpClient.layer`, where `fetchShim` calls `handler`. [T12] L182–190
- **Real-socket alternatives (public, `@category testing`):**
  - `HttpServer.layerTestClient` / `HttpServer.makeTestClient`: an `HttpClient` that prefixes the running `HttpServer`'s URL. [E3] L335–380
  - `@effect/platform-bun@4.0.2` `BunHttpServer.layerTest`: `layer({ hostname: "127.0.0.1", port: 0 })` plus `layerTestClient`, with `FetchHttpClient` set to `keepalive: false`. [T15] L359–374

  The router app is attached with `HttpRouter.serve(appLayer)`. **Not used by the upstream MCP tests.**

- **Test runner pieces.**
  - `@effect/vitest` provides `it.effect`, `it.layer(..., { excludeTestServices })` and `it.live`.
  - `effect/testing` exports `TestClock`.
  - `Stdio.layerTest` covers stdio.

  [V1], [T11] L90–94

- **Repository-only helpers (not published).** `makeHttpHarness`, `initializeHttpSession`, `readMcpHttpResponse`, `makeMcpSseReader`, `makeServerLayer`, `McpConformance`, and `makeMcpTestPeer` can only be copied, not imported. Some tests also import internal modules (`effect/ai/internal/mcpCore`, `…/mcpProtocol/v2026_07_28`) through repo tsconfig paths. The published `exports` map has `"./*": "./dist/*.js"` and nulls only `./internal/*`, `./cli/internal/*` and `./cluster/internal/*`. These internals are undocumented and not a stable API. [T8]–[T11], [R2]

## Sources

Base: `https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/`

[R1]: https://github.com/Effect-TS/effect/tree/effect%404.0.2
[R2]: https://unpkg.com/effect@4.0.2/package.json
[R3]: https://registry.npmjs.org/@effect/vitest/4.0.2
[T1]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/v2025_06_18.test.ts
[T2]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/v2025_11_25.test.ts
[T3]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/v2026_07_28.test.ts
[T4]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/McpConformance/ToolsTest.ts
[T5]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/McpConformance/McpConformance.ts
[T6]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/McpConformance/McpConformanceFixtures.ts
[T7]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/McpConformance/McpTestPeer.ts
[T8]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/TestUtils/McpHttpHarness.ts
[T9]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/TestUtils/McpHttpResponse.ts
[T10]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/TestUtils/McpServerLayer.ts
[T11]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/TestUtils/McpStdioHarness.ts
[T12]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/McpServer.test.ts
[T13]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/ProtocolAdapters.test.ts
[T14]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/McpProtocol.test.ts
[T15]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/platform/bun/src/BunHttpServer.ts#L359-L374
[T16]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/platform/bun/test/BunHttpServer.test.ts#L185-L222
[T17]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/McpConformance/UtilitiesTest.ts
[T18]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/McpConformance/TransportsTest.ts
[T19]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/effect/test/ai/McpServer/McpConformance/BaseProtocolTest.ts
[V1]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/vitest/src/index.ts
[V2]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/packages/vitest/src/internal/internal.ts
[C1]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/vitest.config.ts
[C2]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/.github/workflows/check.yml#L113-L142
[E1]: https://unpkg.com/effect@4.0.2/src/ai/McpSchema.ts
[E2]: https://unpkg.com/effect@4.0.2/src/http/HttpRouter.ts
[E3]: https://unpkg.com/effect@4.0.2/src/http/HttpServer.ts
