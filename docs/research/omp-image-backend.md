# OMP image backend: factual constraints

Research date: 2026-10-10. These are source findings and existing proof limits, not implementation decisions.

## Versions and evidence

- Installed public packages inspected: `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-coding-agent`, and `@oh-my-pi/pi-catalog` **18.8.9**, under `/home/fnd/.bun/install/global/node_modules/@oh-my-pi/`. Upstream snapshot: **`fa5ff4a3a977a28b93d025f4cf50f046e019f18c`**. Its AI/coding-agent manifests also report 18.8.9. Published manifests point runtime imports to source TypeScript and declarations to `dist/types`; repository manifests point both to source. [AI manifest][ai-package], [coding-agent manifest][agent-package], [published catalog manifest](https://unpkg.com/@oh-my-pi/pi-catalog@18.8.9/package.json).
- SHA-256 comparisons confirmed byte-identical installed/upstream source for `ai/src/images/index.ts`, `ai/src/images/openai-hosted.ts`, `coding-agent/src/tools/image-gen.ts`, and `ai/src/auth-storage.ts`. Citations below use the pinned snapshot or versioned published source, not a moving branch.
- Earlier research was recovered first from local agent memory and registered histories `Headless host auth and registry construction`, `Codex carrier resolution and transport proof`, and `Image tool implementation and reuse boundary`. These are local historical evidence, not public documentation.
- The archived auth-worker result reports `headlessImports: PASS`, `isolatedRegistry: PASS`, `mockOAuthResolution: PASS`, image ID `gpt-image-2`, `networkCalls: 0`, and `ModelRegistry.create`/`availableModels` as undefined. The earlier transport record describes injected-fetch generation/edit requests to `POST https://chatgpt.com/backend-api/codex/responses`, selected image `openai-codex/gpt-image-2`, carrier `gpt-6.1-sol`, and synthetic image responses. These fake-input proofs were **not repeated**.
- **No live generation, real OAuth refresh, subscription entitlement, billing, backend latency, or real concurrent OMP/service credential usage has been exercised.** This research did not inspect real credential databases, `.env` files, or secret configuration; install dependencies; call image providers; or start services. New executable work was limited to read-only public-source checksums and catalog projections.

## Original `generate_image` tool versus the low-level image client

Follow-up scope from the parent interview: OMP and Codex CLI clients, generation plus editing, and the existing host OMP profile. The requested reuse boundary is the **original OMP tool**, not a new prompt-only API.

### Public exports and discoverable parameters

`@oh-my-pi/pi-coding-agent/tools/image-gen` exposes `imageGenSchema`, exported inferred type `ImageGenParams`, `imageGenTool`, `getImageGenTools`, and `getImageGenToolsWithRegistry`. The published declaration carries the concrete parameter and result-detail types. Both factory functions return the same original singleton tool; their registry/active-model arguments are ignored, so they do not pre-bind execution context. [Exports/schema](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/tools/image-gen.ts#L29-L67), [factories](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/tools/image-gen.ts#L343-L355), [published declaration](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.8.9/dist/types/tools/image-gen.d.ts), [public wildcard export][agent-package].

| Original parameter                                            | Schema                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `subject`                                                     | Required string, description “main subject”                                |
| `action`, `scene`, `composition`, `lighting`, `style`, `text` | Optional strings, each with its original description                       |
| `changes`                                                     | Optional string array, description “edits to make”                         |
| `aspect_ratio`                                                | Optional enum: `1:1`, `3:4`, `4:3`, `9:16`, `16:9`, `3:2`, `2:3`           |
| `image_size`                                                  | Optional enum: `1024x1024`, `1536x1024`, `1024x1536`                       |
| `input`                                                       | Optional array of objects with optional string `path`, `data`, `mime_type` |
| `model`                                                       | Optional string, description “image model selector for this request”       |

The schema supplies descriptions but **no defaults, nonempty-string constraint, reference-count limit, base64/MIME format validation, or input-object either/or requirement**. Runtime input resolution supplies additional rules, described below. Requiring different fields, adding new generation/edit names, or changing model to a static enum would no longer be this exact upstream parameter contract. [Schema](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/tools/image-gen.ts#L29-L51).

Metadata: name `generate_image`, label `GenerateImage`, `strict: false`, `approval: "write"`, `parameters: imageGenSchema`; description is the original rendered bundled prompt. It instructs a detailed subject for generation/editing, naming each reference's role for multiple inputs, and optional model selection. The metadata declares OMP approval behavior; the direct execute function does not itself run the harness approval gate. [Tool object](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/tools/image-gen.ts#L230-L240), [bundled description](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/prompts/tools/image-gen.md).

Schema reuse facts (source/declarations only; conversion was not executed):

- The exported schema is an omptype `FluentType`; `ImageGenParams = typeof imageGenSchema.infer` and `typeof imageGenSchema.inferIn` carry the precise authored shape. `imageGenSchema.assert(unknown)` validates and returns that typed value. Inference properties are type-only. Its plain strings/arrays/objects/literal unions have no morph or custom-predicate conversion obstacle. [Published schema declaration](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.8.9/dist/types/tools/image-gen.d.ts), [omptype 18.8.9 interface](https://unpkg.com/@oh-my-pi/omptype@18.8.9/src/type.ts).
- **[INFERENCE, source-derived]** `imageGenSchema.toJsonSchema({ io: "input", target: "draft-2020-12", dialect: null })` emits the original object schema without duplicating fields. Root required list is `["subject"]`; optional fields remain optional rather than nullable; enums, array item shapes and original descriptions survive. Authored plain objects keep extra properties; direct conversion therefore does not add `additionalProperties: false`. Conversion returns `Record<string, unknown>`, so a typed MCP SDK still needs to establish its object-root schema boundary. [Conversion implementation](https://unpkg.com/@oh-my-pi/omptype@18.8.9/src/json-schema.ts), [authored-object defaults](https://unpkg.com/@oh-my-pi/omptype@18.8.9/src/ir.ts).
- There is also **existing public OMP wire conversion**, `arkToWireSchema(imageGenSchema)` / `toolWireSchema(imageGenTool)`, exported from `@oh-my-pi/pi-ai/utils/schema`. It converts to draft 2020-12, removes `$schema`, processes undefined branches, and recursively closes declared objects missing explicit extras rules. **[INFERENCE]** For this schema it closes both root and input-item objects. That is OMP's provider-facing wire shape, distinct from the authored validator's keep-extras behavior. Codex tools already use `toolWireSchema`; the GitLab workflow's MCP tool-definition builder uses its result as `inputSchema`. This is a reusable conversion, not a second schema definition. [Public barrel](https://unpkg.com/@oh-my-pi/pi-ai@18.8.9/src/utils/schema/index.ts), [wire conversion](https://unpkg.com/@oh-my-pi/pi-ai@18.8.9/src/utils/schema/wire.ts), [Codex use](https://unpkg.com/@oh-my-pi/pi-ai@18.8.9/src/providers/openai-codex-responses.ts), [existing MCP-shaped use](https://unpkg.com/@oh-my-pi/pi-ai@18.8.9/src/providers/gitlab-duo-workflow.ts).
- `imageGenTool` is publicly typed as `CustomTool<typeof imageGenSchema, ImageGenToolDetails>`. The details interface is not separately exported by name, but **[INFERENCE, not compiler-tested]** `Awaited<ReturnType<typeof imageGenTool.execute>>` preserves the concrete result type; `NonNullable<...['details']>` derives the concrete detail shape, not `any`; `Parameters<typeof imageGenTool.execute>` preserves parameters/context/signal types. Public `GeneratedImage`/`ImageGenerationResult` are available from pi-ai. [Published declaration](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.8.9/dist/types/tools/image-gen.d.ts), [generic result](https://unpkg.com/@oh-my-pi/pi-agent-core@18.8.9/dist/types/types.d.ts).
- **No reusable runtime image-result/output schema exists in this source.** Results/details are interfaces and plain objects; `CustomTool` provides an input schema but no output-schema property. `imageGenSchema.toJsonSchema({ io: "output" })` describes the validator's parameter output, **not** tool execution results. Compile-time precision is reusable; claiming automatic discoverable/runtime-validated MCP result structure would be unsupported. [Tool/result definitions](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.8.9/src/tools/image-gen.ts), [CustomTool contract](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.8.9/src/extensibility/custom-tools/types.ts).

### Original options, defaults, and result semantics

- Prompt assembly is already implemented: subject/action/scene are joined with commas; composition/lighting/style become sentences with trailing punctuation normalized; requested text and changes are appended as labelled text/bullets. `changes` does not itself choose the provider's edit route; input reference presence does. These helpers are internal, but invoking `imageGenTool.execute` preserves them without copying them. [Prompt assembly](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/tools/image-gen.ts#L69-L81), [dispatch][hosted].
- If `model` is omitted/falsey, the original image-role/default selection and carrier policy run. Aspect/size are passed through as optional values; no wrapper-level default is added. It always passes `count: 1` to the image client; there is no public count parameter. It keeps credential preflight/resolvers, dynamic carrier/model headers, original candidate fallback, three-minute timeout, and abort handling. `_toolCallId` and `_onUpdate` are unused by this execute implementation. [Execution](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/tools/image-gen.ts#L237-L340).
- `input.path` wins if both path and data are truthy. Paths are resolved against the host-side context cwd. Path loading checks special-file kind, maximum **35 MiB**, and recognized image metadata. Byte inputs already support raw base64 plus `mime_type`, or a `data:<mime>;base64,...` URL that supplies MIME. Missing/empty input data or missing MIME throws. The file-size checks do **not** bound raw `input.data` in this source. [Input resolution](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/tools/image-gen.ts#L84-L117), [size constant](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/tools/image-gen.ts#L26-L27).
- Results are `AgentToolResult`, not `ImageGenerationResult` or MCP `CallToolResult`. The original result's `content` contains **text**, including provider, actual/catalog model, generated host temporary paths, optional size/quality and provider response text. `details` contains `provider`, `model`, `imageCount`, `imagePaths`, `images: GeneratedImage[]`, `responseText?`, and `usage?`. No-image results return successful text “No image data returned” plus optional provider text, with zero-count/empty-image details. [Result construction](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/tools/image-gen.ts#L186-L228).
- Every returned image is also written to `os.tmpdir()/omp-image-<Snowflake>.<extension>` before the tool resolves. The original function exposes no disable-temp-files option or cleanup callback. Using the original implementation retains this side effect even if the caller consumes only base64 from `details.images`. [Temporary writes](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/tools/image-gen.ts#L120-L138).

### Headless runtime reuse versus complete TypeScript context

The earlier isolated proof actually invoked **the original** `imageGenTool.execute`, not merely the low-level image client. Its runtime context supplied a session-manager-shaped object with `getSessionId`/`getCwd`, real isolated registry/settings, optional active model, and injected fetch. Execution reached the real hosted transport; injected fetch threw a sentinel. Archived stdout reports `minimalToolContext: PASS`, `mockFetchCalls: 1`, `realNetworkCalls: 0`, endpoint `https://chatgpt.com/backend-api/codex/responses`, selected carrier `gpt-6-luna`, and `toolType: image_generation`. This proves original execution can run without AgentSession/TUI, **not** that the tiny JavaScript context satisfies its TypeScript interface or that generation succeeded. [Archived evidence: `agent://Headless host auth and registry construction/markdown`], [execution dependencies][image-tool].

The declared signature is `execute(toolCallId, params, onUpdate, ctx: CustomToolContext, signal?): Promise<AgentToolResult<...>>`. Generic `CustomToolContext` requires a full `ReadonlySessionManager`, `modelRegistry`, `model`, `isIdle()`, `hasQueuedMessages()`, and `abort()`; settings/fetch are optional. The image implementation reads only manager `getSessionId()`/`getCwd()`, registry, model, settings and fetch. Explicit settings avoids relying on an initialized global Settings singleton. **A minimal runtime duck type is not a completely typed public call boundary.** [Custom-tool contract](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/extensibility/custom-tools/types.ts#L88-L109), [execute type](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/extensibility/custom-tools/types.ts#L233-L239).

`ReadonlySessionManager` is a Pick of more than twenty public SessionManager methods, not just those two. The public `SessionManager.inMemory(cwd)` constructs an actual manager without session-file persistence and without creating AgentSession or invoking a model. This is an available source fact, not a selected service lifecycle. The original tool still expects a session-manager interface/ID; “no running agent or AgentSession required” is accurate, whereas “no session context required” is not. [Manager type](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/session/session-manager.ts#L679-L703), [in-memory factory](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/session/session-manager.ts#L4284-L4292).

### Remote boundary differences that remain even with original execution

1. Client-local file paths are not host-local file paths. The existing `input.data`/`mime_type` or data-URL form already carries editing bytes remotely; generation/editing therefore does not inherently require a different parameter vocabulary, separate edit tool, or extra upload endpoint. Keeping `path` means it refers to the **server's** filesystem, not the remote client's. [Input implementation](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/tools/image-gen.ts#L90-L117).
2. Original text containing temporary paths is not portable image delivery. Base64 and MIME are already available in `details.images`, so remote content conversion need not re-open files or regenerate/re-encode provider images. Mapping the original result into MCP content/structured-result/error envelopes remains a protocol adaptation; it is not provided by this original tool. [Original result][image-tool].
3. Caller cancellation, host cwd/session ID/settings/registry and OMP permission metadata need a host-side execution context/protocol boundary. Reusing the original tool does not supply an MCP server or automatically apply harness approval gates. No choices about those lifecycles/policies are recorded here.

Compared with invoking `pi-ai.generateImage` directly, original-tool reuse preserves the existing prompt interface, schema descriptions/enums, role/model/carrier selection, credential/header handling, input resolution, timeout/fallback policy, and result formatting. The low-level API alone does not preserve those behaviors. Native MCP content adaptation and the wide declared context remain the important seam facts, not reasons to invent a second image API.

## Public callable contract

`@oh-my-pi/pi-ai/images` is an explicit public export. The AI root also re-exports images. Its dispatcher is:

```ts
generateImage(
  model: Model<Api>,
  request: ImageGenerationRequest,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult>
```

[Package export][ai-package], [root export](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/ai/src/index.ts#L10), [dispatcher][dispatcher].

| Object                   | Exact fields                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ImageInput`             | `data: string`, `mimeType: string`                                                                                                          |
| `ImageGenerationRequest` | Required `prompt: string`; optional `inputImages: ImageInput[]`, `aspectRatio: string`, `imageSize: string`, `count: number`                |
| `ImageGenerationOptions` | Required `apiKey: string \| ApiKeyResolver`; optional `fetch: FetchImpl`, `signal: AbortSignal`, `carrier: Model<Api>`, `sessionId: string` |
| `GeneratedImage`         | `data: string`, `mimeType: string`; optional provider-reported `size: string`, `quality: string`                                            |
| `ImageGenerationResult`  | `images: GeneratedImage[]`, `usage: Usage`; optional `text: string`, `model: string`                                                        |

[Interfaces][image-types], [credential types][auth-retry]. `ApiKeyResolver` receives `{ lastChance, error, previousKey?, signal? }` and returns a string, a structured credential resolution, or undefined, synchronously or asynchronously.

`data` is raw base64 paired with MIME, not a local path. Transports build data URLs or decode bytes into multipart files. The low-level API has no `subject/action/style/changes`, path input, mask, requested output format, progress callback, or MCP response type. Prompt assembly, local image-path loading, and temporary result files are OMP tool-wrapper behavior. [Data URL/mapping][image-shared], [multipart][openai-images], [wrapper][image-tool].

Important result/input limits:

- A resolved promise need not contain an image: hosted refusals can appear as `text` with zero images, and other decoders return whatever valid images were present. Hosted SSE can collect completed output items even without a terminal response. [Hosted collector/parser][hosted], [direct decoder][image-shared].
- `result.model` is optional and, for hosted responses, comes from echoed `tools[].model`, not automatically the selected catalog ID. Hosted MIME is sniffed with WebP fallback; direct image MIME uses a supplied media type or sniffing with PNG fallback. `size`/`quality` are only populated when supplied by hosted output. [Hosted collector][hosted], [decoder][image-shared].
- Library aspect/size fields are strings, not the wrapper's enums. Explicit `imageSize` wins for OpenAI-shaped size mapping; `1:1` maps to 1024x1024, `3:4`/`9:16` to 1024x1536, `4:3`/`16:9` to 1536x1024; other aspect ratios produce no inferred size. [Mapping][image-shared].
- `Usage` is mandatory but can contain zero/default accounting when the response lacks usage; this does not establish actual provider cost. [Usage conversion][image-shared].

## Implemented transport paths

Dispatch is by **`model.api`**, not provider name, `kind`, or chat image-input support. An implemented transport is not proof that a remote account/model accepts the request. [Dispatcher][dispatcher], [API/kind definitions][catalog-types].

| API                                           | Implemented path/auth                                                                                                                         | Inputs/count                                                                                                                                                                                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openai-images`                               | Configured base URL plus `/images/generations`; edits via `/images/edits`; Bearer auth                                                        | `n = count ?? 1`. Provider exactly `openai` uses multipart edits; others use JSON references. Edit HTTP 404 triggers a generations-route fallback. xAI/xAI-OAuth have bearer-dependent routing, resolution mapping, and a maximum of three reference images. |
| `openrouter-images`                           | Configured base URL plus `/images`; Bearer auth                                                                                               | JSON `input_references`, `aspect_ratio`, `image_size`, `n = count ?? 1`.                                                                                                                                                                                     |
| `google-generative-ai`                        | `/models/<requestModelId or id>:generateContent`; `x-goog-api-key`                                                                            | Inline image parts; image config passed through; `candidateCount` only when count is truthy.                                                                                                                                                                 |
| `google-gemini-cli`                           | Antigravity model discovery, then `/v1internal:streamGenerateContent?alt=sse`; JSON credential `{ token, projectId }` supplies Bearer/project | Advertised image ID may replace selected ID; primary/sandbox fallback on 429/5xx. Inline references; `candidateCount = count ?? 1`. This transport does not call generic model-header resolution.                                                            |
| `openai-responses` / `openai-codex-responses` | Explicit Responses carrier, described below                                                                                                   | Generate/edit follows reference presence. Requests WebP. **Ignores `count`**.                                                                                                                                                                                |

Sources: [OpenAI-shaped][openai-images], [OpenRouter][openrouter-images], [Gemini][google-images], [Antigravity][antigravity-images], [hosted][hosted].

APIs outside this switch, including `azure-openai-responses`, `google-vertex`, and `openai-completions`, throw a validation error. In particular, “chat accepts image input” does not mean “can generate images.” [Dispatcher][dispatcher]. The `google-gemini-cli` switch arm specifically invokes Antigravity image code; it is not evidence of an independent generic Gemini CLI image backend.

### Installed bundled catalog, not host account discovery

A read-only `jq` projection of published 18.8.9 `pi-catalog/src/models.json` found:

| Provider             | Image catalog entries/API                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai-codex`       | `gpt-image-2`; `openai-codex-responses`                                                                                                                                                              |
| `openai`             | `chatgpt-image-latest`, `gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`, `gpt-image-2`; **all five use Responses**, not `openai-images`                                                           |
| `google`             | Six: `gemini-2.5-flash-image`, `gemini-3-pro-image`, `gemini-3-pro-image-preview`, `gemini-3.1-flash-image`, `gemini-3.1-flash-image-preview`, `gemini-3.1-flash-lite-image`; `google-generative-ai` |
| `google-antigravity` | `gemini-3-pro-image`, `gemini-3.1-flash-image`; `google-gemini-cli`                                                                                                                                  |
| `deepinfra`          | `black-forest-labs/FLUX-2-pro`; `openai-images`                                                                                                                                                      |
| `xai`                | `grok-imagine-image`, `grok-imagine-image-quality`; `openai-images`                                                                                                                                  |
| `xai-oauth`          | `grok-imagine-image`; `openai-images`                                                                                                                                                                |
| `openrouter`         | 59 image entries, including OpenAI/Gemini/FLUX/Seedream/Recraft families; `openrouter-images`                                                                                                        |

[Versioned catalog][catalog-json]. Inspected SHA-256: `2b56eaf0d5556b5d5da8ac99fa753e4fbd32232045600eca205d290208be59b1`. This is a fixed bundled inventory; configured/discovered models can differ.

The same catalog has hosted-image-flagged chat entries on supported Responses APIs for `openai` (38), `openai-codex` (7), `github-copilot` (20), `bedrock-mantle` (5), `gitlab-duo` (5), `opencode-go` (2), and `opencode-zen` (24). Codex carriers include `gpt-5.6-luna/sol/terra`, `gpt-6-astra/luna/sol`, and `gpt-6.1-sol`. These are **metadata, not demonstrated generation support**. Some other GitLab Duo rows carry `hostedImage: true` but use `openai-completions`, which the hosted carrier guard rejects. [Catalog][catalog-json], [carrier guard][hosted].

## Image generator versus hosted chat carrier

- `kind: image` describes an image entry; absent kind means chat. `hostedImage` describes chat capability to carry Responses `image_generation`; `imageModel` identifies a same-provider preferred image replacement. These are distinct fields. [Definitions][catalog-types].
- The original tool's image-role pool is `registry.getAvailable("all")` filtered to image kind. Explicit selection chooses one candidate. Otherwise it orders explicit role-chain entries first, then the session's configured image replacement/hosted session model, then nonexplicit chain entries, deduplicating provider/ID. **The library does not perform this selection/fallback policy.** [Image eligibility][model-roles], [wrapper selection][image-tool].
- The wrapper uses the selected model itself as carrier if `hostedImage`; otherwise the active same-provider hosted chat model, or the available same-provider hosted chat model with lowest input cost. Outbound auth uses the **carrier** resolver. [Carrier selection/auth][image-tool].
- The bare hosted function requires an explicit carrier with API `openai-responses` or `openai-codex-responses`. It does **not** enforce same-provider matching or the `hostedImage` flag; those are wrapper/catalog policy. It creates no nested agent, AgentSession, or model conversation. [Hosted function][hosted].
- Request body `model` is the carrier's `requestModelId ?? id`. Only when the selected entry is image-kind **ordinary `openai-responses`** does `tools[0].model` specify its image ID. **Codex does not send the selected image ID as tool model**: the backend can substitute its own generator. A hosted chat entry generating directly also leaves generator selection to the host. [Request construction][hosted].
- References become `input_image` data URLs. Action is `edit` if references exist, otherwise `generate`. Both use `tool_choice: image_generation`, `store: false`, and `output_format: webp`. Codex requests streaming SSE with image instructions; ordinary Responses accepts JSON or SSE. [Request/parser][hosted].
- Codex defaults to `https://chatgpt.com/backend-api/codex/responses`; ordinary OpenAI defaults to `https://api.openai.com/v1/responses`; carrier `baseUrl` can change routing. Headers merge carrier static/dynamic headers, then set content type/Bearer. Codex removes `x-api-key`, derives account ID/residency from the bearer, sets beta/originator/user-agent, and adds conversation/session headers only if `sessionId` is supplied. No session ID is allocated automatically. [URL/headers][hosted].
- The existing auth-gateway image route explicitly rejects both hosted APIs because it cannot resolve the carrier. This is not a restriction of the standalone library. [Gateway guard][gateway-images].

## Credential, header, and factory lifecycle

The coding-agent public root exports `getAgentDir`, `Settings`, `ModelRegistry`, `AuthStorage`, and SDK `discoverAuthStorage`. AuthStorage lives in the AI package and is re-exported. [Root exports][agent-index], [auth re-export][auth-reexport].

- `Settings.loadReadOnly(options)` loads effective YAML/project settings without opening agent.db, migrating legacy settings, or writing marker files. `discoverAuthStorage(agentDir = getAgentDir(), options = {})` accepts settings/cwd and account-policy/storage options, then delegates to shared discovery. [Settings][settings], [SDK factory][sdk].
- Shared discovery opens local SQLite through `getAgentDbPath(agentDir)` unless broker configuration selects remote storage, constructs AuthStorage, and reloads credentials. Local opening is **not** a read-only operation. Broker mode may fetch an initial snapshot and starts background snapshot synchronization; an explicitly configured broker failure does not silently revert to local auth. [Shared factory][auth-discover], [broker failure policy][broker-config].
- `OMP_PROFILE` precedes legacy `PI_PROFILE`. Named profiles derive `~/.omp/profiles/<profile>/agent`; default mode can honor `PI_CODING_AGENT_DIR`. DB helpers handle Linux/XDG paths rather than always concatenating `agentDir/agent.db`. Public utils initialization also reads config-root/agent/project `.env` files; only that source, not those files, was inspected here. [Profiles/DB helpers][dirs], [environment initialization][env-init].
- Available registry construction is `new ModelRegistry(authStorage, modelsPath?, { settings?, cacheDbPath?, fetch?, ignoreLocalModelConfig? })`. Default config is `getAgentDir()/models.yml`. Constructor loading is synchronous and includes config/cache layers and possible config migrations. Its comment mentions `ModelRegistry.create`, but the earlier public-import proof found that factory absent; **the comment is not an available API**. [Constructor][registry], prior evidence above.
- `refresh()` defaults to `online-if-uncached` and can perform catalog network I/O. `hydrateCredentialScopedModelCaches()` invokes an offline strategy. Extension provider loading is a separate CLI/session step, not automatic in registry construction. [Registry lifecycle][registry], [extension loader definitions][sdk].
- `getAvailable(kind = "chat")` checks configured auth/keyless state and disabled providers synchronously; it does not refresh OAuth or prove model entitlement. Image entries require `"image"`/`"all"`. Public instance APIs include `find(provider, id)`, `getApiKey(model, sessionId?, { signal? })`, and `resolver(model, sessionId?)`; there is no `availableModels()` API in the earlier import proof. [Availability/auth][registry].
- Credential priority: runtime override → config override → stored OAuth → login-stored API key → config fallback → environment → stored API key. A static key makes one attempt; a resolver retains request-time refresh/rotation. Existing `withAuth` ordinarily refreshes the same account once on auth failure, then rotates distinct siblings; 403/usage-limit paths can rotate directly, bounded by cycle/attempt guards. These are upstream retries, not newly agreed bridge behavior. [Cascade][cascade], [auth driver][auth-retry].
- `registry.resolveModelHeaders(model, signal?)` invokes the model resolver or copies static headers. Image transports merge static/dynamic headers at request time. Hosted generation resolves **carrier** headers, not image-entry-only headers. Keeping registry models' request-time resolvers differs from freezing headers at startup. [Registry header API][registry], [image merge][image-shared], [hosted headers][hosted].
- Configured values can be literals, environment-backed, or `!command`-backed. Successful command output is cached; in-flight commands are shared; failures have 30-second backoff; commands have a 10-second timeout. Environment/literal values remain live. Aborting a header waiter does not necessarily stop a shared command. “Dynamic” therefore does not mean executing a command on every image request. [Config resolver/cache][config-values].
- Auth settings live synchronization is explicit `createAuthStorageSettingsSync`, following broker/account-policy changes and exposing `settled()`/`stop()`. A bare discovery call does not install that watcher. Factory construction alone does not establish hot-reload behavior for a long-running service. [Settings synchronization][broker-config].

## Abort signal and cancellation limits

- `generateImage` exposes caller-owned `signal`, passed to fetch, credential retry/resolution, dynamic headers, output URL downloads, Antigravity discovery, and SSE iteration. There is **no overall timeout in the standalone dispatcher**. The OMP tool separately combines a three-minute timeout and uses `untilAborted`; direct callers do not inherit this wrapper. [Options][image-types], [transport implementations][dispatcher], [wrapper deadline][image-tool], [downloads][image-shared].
- `abortableSource` cancels the stream reader on abort/early exit and releases its lock. However `readSseEvents` catches an abort and returns; hosted/Antigravity image parsers subsequently collect accumulated output without a final aborted/completed check. **[INFERENCE from source] abort after an SSE body opens can resolve empty/partial images rather than necessarily reject.** This was not runtime-tested. The wrapper's outer `untilAborted` rejects on its caller signal, but this does not impose a universal low-level cancellation error contract. [Reader][abortable], [SSE abort suppression][sse], [hosted parser][hosted], [Antigravity parser][antigravity-images].
- Local abort is not evidence that the provider stops processing or avoids charges. The API exposes no provider-side cancellation acknowledgment/refund mechanism.

## Shared-profile OAuth refresh guards

This section was independently traced through installed public **pi-ai 18.8.9** source. It is not a exercised cross-process guarantee.

### Durable coordination

- `AuthStorage.create(dbPath)` opens an explicit SQLite store. Coordination requires both processes to use the **same database**, not copies containing equivalent credentials. [Storage factory][auth-storage], [SQLite store][sqlite-auth].
- Refresh ownership is persisted per credential row in `auth_credential_refresh_leases`, with random UUID owner and expiry. Atomic acquisition uses `INSERT ... ON CONFLICT UPDATE` only when the previous expiry is past. Lease TTL is **15 seconds**, renewal every **5 seconds**, acquisition polling nominally **50 ms**, bounded to 50–250 ms. Normal credential freshness skew is **60 seconds**. [Refresh constants/ownership][oauth-refresh], [lease SQL][sqlite-auth].
- Each acquisition loop re-lists persisted credentials and refreshes its in-memory provider pool; it repeats the read after acquisition. A fresh peer-rotated credential can be adopted rather than exchanged again. Normal auth resolution also checks external changes via SQLite `PRAGMA data_version` and auth revisions; this is resolution-driven, not a background polling timer. Poll errors are logged/swallowed, so a pool can remain stale. [Refresh loop][oauth-refresh], [pool reload][auth-pool], [selection][auth-select], [revision polling][sqlite-auth].
- Refresh leases are optional for custom stores: all acquisition/expiry/release/renew methods must be implemented for durable ownership to apply. Per-object in-flight maps are additional single-flight mechanisms, not the cross-process guard. [Store capability check][auth-store], [refresher maps][oauth-refresh].

### Fenced persistence and remaining races

- Refresh persistence uses compare-and-swap against the exact old serialized credential data. Fenced update/disable SQL also requires an active credential row and a matching owner/unexpired lease. Its timestamp is passed from `Date.now()`, not checked against SQLite's clock at commit time. CAS loss reloads peer rows instead of overwriting or disabling their replacement credential. Identical-byte updates use a no-write fast path with a separate lease check. [CAS SQL][sqlite-auth], [refresh persistence][oauth-refresh], [pool CAS][auth-pool].
- Release matches row ID and owner, so an obsolete owner cannot delete a successor's lease; release failures are swallowed because expired leases are stealable. Renewal matches owner, not current expiry, and can revive an expired lease if no peer has acquired it. Renewal failure is recorded but does not itself abort the provider operation; the post-success path checks it before persistence, and final fencing still matters. [Lease operations][sqlite-auth], [renewal/cleanup][oauth-refresh].
- **Not exactly-once:** explicit forced refresh paths can serialize and still each mint. The row-ID force path omits the ordinary observed-credential comparison. `refreshById` additionally uses an unfenced data-CAS replacement after lease-backed refresh. [INFERENCE from source] a peer race there can leave durable storage correct while the returned snapshot is not the newest peer value. Neither scenario was exercised. [Force path][oauth-refresh], [pool replacement][auth-pool].

### Cancellation and shutdown

- Joined refresh callers race their own signal without canceling the underlying shared promise. The initiating caller's signal is passed into the actual ordinary internal operation, so aborting that initiator can affect all waiters. Lease waits check/race caller cancellation. [Caller races][auth-abort], [single-flight and operation signals][oauth-refresh].
- `refreshStored`'s default **10-second** operation timeout aborts the callback signal but does not itself race an arbitrary callback. The internal provider-request path separately races timeout/abort. [INFERENCE] a custom callback ignoring its signal can remain pending while leases renew; even the internal race cannot prove a provider exchange stopped. [Refresh timeout/request code][oauth-refresh].
- `AuthStorage.close()` is synchronous and delegates to idempotent pool/store close, finalizing SQLite statements and closing the DB. There is **no refresher drain/shutdown API** in this source: close does not cancel/await in-flight refreshes or clear their timers; store replacement closes the old pool without draining the old refresher. Exact close-under-load errors, late provider token rotations, timer ordering, and crash recovery were not runtime-tested. [Storage lifecycle][auth-storage], [pool close][auth-pool], [SQLite close][sqlite-auth], [refresher][oauth-refresh].

**Supported wording:** upstream implements durable per-row ownership, renewal, peer re-reading, and fenced data-CAS for cooperating processes sharing one SQLite store. This is evidence of coordination machinery, not universal safety, exactly-once exchanges, or graceful cancellation/shutdown across all providers, callbacks, crashes, and OMP versions.

## Unsettled constraints for the interview

1. Desired host-account access, actual image-model substitution, output quality/refusals, latency, limits, and cost remain unknown without a real provider request.
2. Counts, sizes, MIME, edit-reference limits, and control over image model differ by transport; uniform behavior has not been established.
3. Bare SSE cancellation may resolve partial/empty output and does not establish remote billing cancellation.
4. Profile/cwd/broker/config/extension-provider selection and settings synchronization affect a long-lived process. Actual host secret configuration was not inspected.
5. Participating shared-store refresh paths have source guards, but simultaneous real OMP/service refresh and close-under-load have not been exercised; older-version interoperability is unresolved.

No decisions are recorded here about exposed models, client concurrency, persistence, transport, access control, or result-delivery policy.

## Sources

Pinned upstream sources refer to `fa5ff4a3a977a28b93d025f4cf50f046e019f18c`. Versioned published auth references below refer to source inspected from the installed 18.8.9 package.

[ai-package]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/ai/package.json
[agent-package]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/package.json
[dispatcher]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/ai/src/images/index.ts#L19-L45
[image-types]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/ai/src/images/types.ts#L4-L45
[image-shared]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/ai/src/images/shared.ts
[openai-images]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/ai/src/images/openai-images.ts#L14-L122
[openrouter-images]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/ai/src/images/openrouter-images.ts
[google-images]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/ai/src/images/google-generative-ai.ts#L17-L91
[antigravity-images]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/ai/src/images/google-antigravity.ts#L36-L178
[hosted]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/ai/src/images/openai-hosted.ts#L52-L209
[image-tool]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/tools/image-gen.ts#L26-L341
[catalog-json]: https://unpkg.com/@oh-my-pi/pi-catalog@18.8.9/src/models.json
[catalog-types]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/catalog/src/types.ts
[model-roles]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/config/model-roles.ts#L67-L105
[gateway-images]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/ai/src/auth-gateway/routes/images.ts#L61-L66
[agent-index]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/index.ts#L10-L43
[auth-reexport]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/session/auth-storage.ts
[settings]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/config/settings.ts#L739-L745
[sdk]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/sdk.ts#L981-L1033
[auth-discover]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/ai/src/auth-broker/discover.ts#L390-L491
[broker-config]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/session/auth-broker-config.ts#L127-L236
[dirs]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/utils/src/dirs.ts
[env-init]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/utils/src/env.ts#L289-L314
[registry]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/config/model-registry.ts
[cascade]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/ai/src/auth/cascade.ts#L207-L233
[auth-retry]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/ai/src/auth-retry.ts
[config-values]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/config/resolve-config-value.ts
[abortable]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/utils/src/abortable.ts#L13-L90
[sse]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/utils/src/stream.ts#L549-L600
[auth-storage]: https://unpkg.com/@oh-my-pi/pi-ai@18.8.9/src/auth-storage.ts
[oauth-refresh]: https://unpkg.com/@oh-my-pi/pi-ai@18.8.9/src/auth/refresh.ts
[sqlite-auth]: https://unpkg.com/@oh-my-pi/pi-ai@18.8.9/src/auth/sqlite-credential-store.ts
[auth-pool]: https://unpkg.com/@oh-my-pi/pi-ai@18.8.9/src/auth/pool.ts
[auth-select]: https://unpkg.com/@oh-my-pi/pi-ai@18.8.9/src/auth/select.ts
[auth-store]: https://unpkg.com/@oh-my-pi/pi-ai@18.8.9/src/auth/store.ts
[auth-abort]: https://unpkg.com/@oh-my-pi/pi-ai@18.8.9/src/auth/abort.ts
