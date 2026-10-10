# omp-images-mcp

Private, single-package Bun/Effect service wrapping OMP's original
`generate_image` tool. `bun run start` serves authenticated Streamable HTTP MCP
at `/mcp`, listening only on `127.0.0.1:4447` by default. Tailscale Funnel can
publish the loopback service over HTTPS; provider credentials remain on the host.

## ImageService startup

```ts
import { Effect, Layer } from "effect";

import { startupConfig, startupEnvironment } from "./src/image-config.ts";
import * as ImageService from "./src/image-service.ts";

const imageService = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* startupConfig.parse(startupEnvironment);
    return ImageService.layer(config);
  }),
);
```

The entrypoint parses startup configuration through Effect's
`startupEnvironment` provider using the exact namespaced keys below, reads
`OMP_IMAGES_MCP_BEARER_TOKEN_FILE` once, and passes decoded configuration
(including a `Redacted` bearer token) to `ImageService.layer(config)`. Do not pass
raw environment strings or a token directly to `ImageService.layer`.

| Environment key                            | Default / purpose                                     |
| ------------------------------------------ | ----------------------------------------------------- |
| `OMP_IMAGES_MCP_BEARER_TOKEN_FILE`         | Required path to the private token file               |
| `OMP_IMAGES_MCP_PORT`                      | `4447`; listener host is fixed to `127.0.0.1`         |
| `OMP_IMAGES_MCP_PROFILE_DIRECTORY`         | Original OMP `getAgentDir()`                          |
| `OMP_IMAGES_MCP_WORKING_DIRECTORY`         | Original OMP `getProjectDir()`                        |
| `OMP_IMAGES_MCP_MAX_CONCURRENT_EXECUTIONS` | `8`                                                   |
| `OMP_IMAGES_MCP_MAX_REQUEST_BODY_BYTES`    | `52428800` (50 MiB)                                   |
| `OMP_IMAGES_MCP_RETENTION`                 | `24 hours`; finite positive Effect duration           |
| `OMP_IMAGES_MCP_RETENTION_DIRECTORY`       | `$XDG_STATE_HOME/omp-images-mcp/generated`; see below |

`startupEnvironment` maps camelCase configuration fields to constant-case
`OMP_IMAGES_MCP_*` environment names. Object-based ConfigProviders retain the
camelCase fields shown in the service API, including `retentionDirectory`.
Without `XDG_STATE_HOME`, the retained directory defaults to
`$HOME/.local/state/omp-images-mcp/generated`.

`profileDirectory` selects the host's existing OMP profile for provider access
and model preferences; `workingDirectory` provides the OMP tool's working
directory. Authenticate the host OMP CLI for your chosen image provider before
starting the service. Do not accept startup configuration from individual tool
calls or send provider credentials from callers. All three `@oh-my-pi` packages
are pinned to **18.8.9**; keep the host OMP CLI at that version too.

The layer owns the headless OMP execution context, acquires it once at startup,
and closes its auth storage when disposed. Compose it with Effect's
`HttpRouter.toWebHandler` to obtain a request `handler` and `dispose`; requests
use `/mcp` and the configured bearer token. The optional second argument in
`ImageService.layer(config, providerFetch)` is OMP's provider-network test hook,
not a replacement image tool.

Startup limits default to `maxConcurrentExecutions: 8` and
`maxRequestBodyBytes: 50 * 1024 * 1024` (50 MiB). Set the corresponding
environment key to override a limit. A tool call over capacity returns a clear
error immediately, without queuing; initialization, discovery and tool listing
remain available. Capacity is released after completion, failure or cancellation.
Oversized HTTP request bodies receive `413` before MCP parsing or tool execution.
The byte limit is enforced while consuming the body, including uploads without
`Content-Length` or with a misleadingly small value.

The MCP HTTP integration harness exercises the in-process handler. Tests use
`@effect/vitest` and the real OMP tool with controlled provider responses; module
mocking remains prohibited. Run them with
`bun run test`, not Bun's separate `bun test` runner.
`vitest.config.ts` externalizes the `@oh-my-pi` packages to Bun's native loader:
OMP's TypeScript imports include Bun-specific text assets that Vite cannot
transform. The original packages are loaded without module mocks or rewrites.
`test/setup.ts` redirects home, OMP profile, XDG, and temporary-directory roots
under `/dev/shm` before OMP's eager environment imports, isolating tests from the
host's real profile and temporary files.

## Temporary OMP background patches

Bun patches for `@oh-my-pi/pi-catalog@18.8.9`, `@oh-my-pi/pi-ai@18.8.9`, and
`@oh-my-pi/pi-coding-agent@18.8.9` backport the background preference from
[can1357/oh-my-pi#13047](https://github.com/can1357/oh-my-pi/issues/13047) and
the final behavior in [can1357/oh-my-pi#15288](https://github.com/can1357/oh-my-pi/pull/15288):

- `pi-catalog` supplies reviewed `imageBackground` capability metadata, rebuilt
  from catalog policy and the deployment's `officialEndpoint` compatibility.
- `pi-ai` carries the preference through image requests and transports, omits
  unsupported `auto` fields, and rejects unsupported explicit preferences at
  the auth gateway before provider credential resolution.
- `pi-coding-agent` exposes the original tool parameter and preserves explicit
  preferences through candidate selection and fallback, checking both the
  image model and its actual hosted carrier.

The original OMP image tool exposes `background: "transparent" | "opaque" |
"auto"`; the MCP schema derives from OMP's `imageGenSchema`, without a separate
service implementation. Omitting `background` preserves provider defaults. A
non-`auto` preference requires catalog-built `imageBackground` capability
metadata: only the verified `openai-codex/gpt-image-2` official hosted route is
enabled. A hosted carrier must use the same API and an official endpoint;
custom provider or carrier base URLs do not inherit support from the model
name. OpenAI platform `openai/gpt-image-2` and DeepInfra image models are not
enabled; sharing an API transport does not establish background support.
Unsupported candidates are skipped rather than silently dropping the
preference; an unsupported-only selection fails before a provider request.
`auto` does not require this capability, but is forwarded only to a capable
deployment; otherwise the background field is omitted entirely, including on
strict hosts such as DeepInfra. This requests a provider background preference,
not client-side alpha conversion.

The HTTP seam tests use the real OMP tool, controlled Codex SSE responses, and
strict provider stubs to cover official and custom provider/carrier endpoints,
background forwarding, unsupported selections, fallback without losing the
preference, and omitted/`auto` defaults without unsupported request fields.
They do not perform real provider image generation.

Keep all three checked-in patches with the frozen Bun install until an OMP
release includes the final behavior in
[can1357/oh-my-pi#15288](https://github.com/can1357/oh-my-pi/pull/15288). Upgrade
the pinned OMP packages and host CLI together, then remove all three temporary
patch files and their Bun patch registrations, regenerate `bun.lock`, and
verify the released behavior with a fresh frozen install and the seam tests.
Merging the upstream PR alone is not enough to remove patches from these pins.

## Request logs

Each HTTP request emits one structured `image_request` event through Effect
logging with its start time, authentication outcome, tool, selected model,
duration in milliseconds, and outcome. Tool calls include only the authored
prompt fields (including text and changes), never the full arguments or result.
The selected model is the original tool's provider/model result on success; it
is `null` when no result exposes it. An explicit selector is recorded separately
as `requested_model`. Non-tool requests have a `null` tool.

Request bodies are not read for authentication or Origin rejections, so those
events have no prompt. Image input/output data, provider captions, error bodies,
and headers are not logged. Bearer tokens and known image data are redacted even
if echoed in prompt fields or model text. Use an Effect `Logger.layer` to choose
the output sink; the HTTP integration harness captures this same layer.

## Reference images and generated image references

Use the original `input` array for image edits: supply `data` as base64 with
`mime_type`, or supply a `data:image/...;base64,...` URL. OMP still assembles the
prompt and applies `changes`; the service returns native MCP image content and
OMP text metadata, without structured content.

Each output image has an opaque `generated-image:<UUID>` reference in the text
metadata instead of a host temporary path. Pass that exact reference as
`input: [{ path: reference }]` to edit the retained image without uploading it
again. References work across MCP sessions and survive service restarts when
the service uses the same retained directory, until their retention deadline.

Generated images expire **24 hours after creation** by default. Configure a
different retention period at startup with `OMP_IMAGES_MCP_RETENTION` (for
example, `OMP_IMAGES_MCP_RETENTION="12 hours"`); clients cannot change it per
call. Generated files and their reference metadata are stored in the private
retained directory (mode `0700`, files `0600`), not solely in the process or
temporary directory. Cleanup runs before HTTP startup and periodically at the
shorter of the retention duration and one minute, deleting expired images even
when their references are never used again. Lookup also enforces the deadline
and deletes expired records. Expired or unavailable references are rejected
with an instruction to re-upload the image. SIGINT/SIGTERM close the server and
dispose the layer without deleting unexpired retained images. After downtime,
startup cleanup removes images whose deadlines passed while the service was
stopped.

`input.path` accepts only a retained generated image reference issued by this
service. Arbitrary host files, client-local paths, traversal attempts, symlinks,
and unknown references are invalid tool input, even when paired with `data`.
The service validates every reference before running OMP. Retained records hold
only the retained file path, MIME type, and creation timestamp; accepted references
load their bytes from that file on demand, never from caller-supplied host paths.
Image bytes are not cached in RAM for the retention period.

## Validation and failure boundary

The exposed `generate_image` parameters derive from OMP's original
`imageGenSchema`, with two deliberate schema deviations: `input.path` describes
retained generated image references instead of host paths, and `model` gains a
host-specific enum when usable authenticated image models are available. The
original model description and all other schema details are preserved.

Discover model choices through the tool's MCP input schema. At startup the
service takes OMP's usable authenticated image candidate pool, keeps only
image-generation APIs, and publishes deduplicated `provider/id` values in pool
order. This list is fixed for the running service: restart after adding or
removing an OMP provider login. A model outside a published enum returns MCP
`InvalidParams` before any provider request. Accepted values pass unchanged to
the original OMP tool and resolver, including IDs containing slashes; OMP still
owns model selection and fallback. If the pool is empty, `model` remains the
original free string, and OMP supplies its normal model or credential error.
The service does not duplicate OMP's prompt or image-input validation.

OMP 18.8.9 has no dedicated validation-error class. The adapter preserves
messages only for errors thrown directly by the pinned original `image-gen.ts`
before provider fetch begins, identified by the error's top stack frame. This
keeps OMP's unknown-model, empty-input-entry, and missing-MIME guidance without
a message allowlist. Credential, registry, network, provider, and exhausted
fallback-chain failures remain generic `Image request failed` results. Changes
to upstream error source locations fail closed to that generic message.
Invalid arguments remain protocol-appropriate MCP errors; execution failures
are error-flagged tool results, never provider error bodies.

## Deployment

These are operator instructions, not actions performed by the repository. Keep
the shared bearer token outside the checkout; never put it in Git, a unit file,
command-line arguments, or provider configuration. Create it on the service host:

```sh
install -d -m 700 "$HOME/.config/omp-images-mcp"
(umask 077; openssl rand -hex 32 > "$HOME/.config/omp-images-mcp/token")
chmod 600 "$HOME/.config/omp-images-mcp/token"
OMP_IMAGES_MCP_BEARER_TOKEN_FILE="$HOME/.config/omp-images-mcp/token" bun run start
```

Startup accepts a regular, service-user-owned file with no group/world permission
bits. One final LF or CRLF from `openssl` is removed; empty or whitespace-only
tokens are rejected. Configuration failures do not echo the token.

### User systemd service

Install the [unit template](deploy/omp-images-mcp.service) after the frozen Bun
install. It assumes the checkout is `~/GIT/omp-images-mcp` and Bun is
`~/.bun/bin/bun`; adapt those two paths if necessary. Its environment contains
only the token **path** and non-secret settings. OMP directory defaults are kept;
use a user-unit drop-in with
`Environment=OMP_IMAGES_MCP_PROFILE_DIRECTORY=...` or
`Environment=OMP_IMAGES_MCP_WORKING_DIRECTORY=...` if the host uses different
locations. Set `OMP_IMAGES_MCP_RETENTION_DIRECTORY` to choose a different private
state directory.

```sh
install -d -m 700 "$HOME/.config/systemd/user"
install -m 644 deploy/omp-images-mcp.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now omp-images-mcp.service
systemctl --user status omp-images-mcp.service
journalctl --user -u omp-images-mcp.service
sudo loginctl enable-linger "$USER"
```

Linger starts the user manager at boot and keeps it after logout; enabling the
unit alone is not sufficient for unattended boot. The unit runs Bun directly
(`bun src/main.ts`), avoiding a script-runner intermediary for signals.
`Restart=on-failure` recovers from failures. SIGINT/SIGTERM interrupt active
requests and dispose the server and OMP auth storage, preserving retained files;
a restart cancels in-flight generation rather than waiting for its normal
completion.
`TimeoutStopSec=30s` leaves room for OMP's ten-second shutdown-cleanup deadline.
See the primary [systemd service documentation][systemd-service] and
[loginctl linger documentation][loginctl].

Rotate by replacing the file atomically in the same directory, then restart:

```sh
(
  set -e
  umask 077
  token_dir="$HOME/.config/omp-images-mcp"
  token_tmp=$(mktemp "$token_dir/token.XXXXXX")
  openssl rand -hex 32 > "$token_tmp"
  chmod 600 "$token_tmp"
  mv -f "$token_tmp" "$token_dir/token"
) && systemctl --user restart omp-images-mcp.service
```

The token is acquired once, not hot-reloaded. Distribute the new secret securely
to clients and restart/reconnect them with the new environment value. Restarting
preserves unexpired generated-image references; there is no overlap period for
the old token. Do not print the token or include it in support logs.

### Public HTTPS through Tailscale Funnel

On the service host, with Funnel permitted by the tailnet policy and Tailscale
HTTPS enabled (`<host>.<tailnet>.ts.net` below stands for that machine's
Tailscale DNS name, shown by `tailscale status --self`):

```sh
tailscale funnel --bg --https=8443 --set-path=/mcp http://127.0.0.1:4447/mcp
tailscale funnel status
```

This publishes **`https://<host>.<tailnet>.ts.net:8443/mcp`**. Include `/mcp`
in both the public mount and full backend URL so the proxy reaches the service's
`/mcp` route, not `/`. This command adds the selected path/port rather than
resetting unrelated Serve/Funnel routes. Funnel is public Internet access, not
tailnet-only access; TLS does not replace the bearer token. Use `tailscale serve`
instead of `funnel` for tailnet-only use.

The installed Tailscale **1.102.4** `funnel --help` confirms `--bg`, `--https`,
`--set-path`, and a full target URL with a path. The official
[Funnel command reference][tailscale-funnel] documents these flags and allowed
HTTPS ports (443, 8443, 10000). Inspect status before changing an existing mapping.

### Operational boundaries

- Every holder of the one shared bearer token can invoke the host image provider
  and use valid generated-image references. There is no per-client identity or
  quota; do not expose the token to untrusted users.
- Eight executions and 50 MiB bodies bound concurrency and individual inbound
  requests, not total provider spend, output size, retained disk use, or requests
  over time. Base64 uploads add overhead. Tune limits and retention for the host.
- Prompts (including requested text and changes) are intentionally logged and can
  be sensitive. Restrict journal access and configure its retention. Redaction of
  known bearer/image data is not general-purpose secret detection.
- Retained images survive graceful and abrupt shutdowns. Monitor the private
  retained directory for disk pressure; expiry cleanup resumes at startup.
  Preserve that directory across restarts to keep unexpired references usable.
- Provider login/subscription entitlement, actual billing, and live image
  generation need operator validation; repository tests use controlled provider
  responses and do not establish those external facts.

[systemd-service]: https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html
[loginctl]: https://www.freedesktop.org/software/systemd/man/latest/loginctl.html
[tailscale-funnel]: https://tailscale.com/docs/reference/tailscale-cli/funnel

## MCP clients

On each client, securely provision a private copy of the shared token outside the
checkout, then export it in the environment that launches OMP or Codex:

```sh
export OMP_IMAGES_MCP_TOKEN="$(cat "$HOME/.config/omp-images-mcp/token")"
```

The client variable is distinct from the service's
`OMP_IMAGES_MCP_BEARER_TOKEN_FILE` setting.
Do not paste the secret into client configuration. Both examples explicitly set
a **300-second** tool timeout, above the original OMP tool's
[180-second deadline][omp-image-tool]. Neither example uses OAuth.

### OMP

Merge this entry into `~/.omp/agent/mcp.json` (or the active profile's
`agent/mcp.json`); project configuration can use `.omp/mcp.json`:

```json
{
  "mcpServers": {
    "omp-images": {
      "type": "http",
      "url": "https://<host>.<tailnet>.ts.net:8443/mcp",
      "headers": {
        "Authorization": "Bearer ${OMP_IMAGES_MCP_TOKEN}"
      },
      "timeout": 300000
    }
  }
}
```

OMP expands the environment placeholder when discovering the server. Ensure the
variable is exported before launching; an unset placeholder stays literal and
fails authentication. `timeout` is in **milliseconds**. The process-wide
`OMP_MCP_TIMEOUT_MS`, if set, overrides this per-server value: unset a shorter
override or set it to `300000`. Reload with `/mcp reload`, then use
`/mcp test omp-images` for connectivity. See OMP's primary
[configuration documentation][omp-mcp-config] and [timeout resolver][omp-timeout].

### Codex CLI

Merge into `~/.codex/config.toml` (project `.codex/config.toml` requires trust):

```toml
[mcp_servers.omp-images]
url = "https://<host>.<tailnet>.ts.net:8443/mcp"
bearer_token_env_var = "OMP_IMAGES_MCP_TOKEN"
tool_timeout_sec = 300
```

`bearer_token_env_var` names the exported variable; its value is sent as a bearer
token. `tool_timeout_sec` is in **seconds**. Restart Codex after changing its
configuration or environment. These keys are documented in the official
[Codex MCP guide][codex-mcp] and confirmed in
[Codex's configuration source][codex-config]. OMP also discovers Codex MCP
configuration; avoid conflicting same-name entries, since OMP-native entries
have higher precedence.

### Bearer-header cloud agents

Configure a **Streamable HTTP** MCP connection with:

- URL: `https://<host>.<tailnet>.ts.net:8443/mcp`.
- Secret environment variable: `OMP_IMAGES_MCP_TOKEN`, provisioned through the
  agent platform's secret store, not a checked-in configuration value.
- Header on every MCP request: `Authorization: Bearer <token>`, where `<token>`
  is read from that environment variable at runtime. Use the platform's secret
  interpolation mechanism; `${OMP_IMAGES_MCP_TOKEN}` is OMP syntax, not a
  universal cloud-agent placeholder.
- Tool/request timeout: **300 seconds**, including any HTTP/proxy timeout; a
  platform capped below 180 seconds cannot reliably wait for this image tool.

The agent must support native MCP image content and have an image-capable model.
Reconnect/re-initialize after a service restart; for an older session-based
client, a `404` for a stale MCP session means initialize again.

### Native image limitations

The service returns native MCP `image` blocks and text metadata, **without
`structuredContent`**. [OMP's bridge][omp-image-bridge] preserves image blocks;
[Codex's content conversion][codex-image-conversion] converts them into model
image inputs, but a non-null `structuredContent` would replace those images with
JSON text. A `resource_link` is not a substitute: Codex passes it as text rather
than fetching pixels, and OMP's inspected bridge has no handling for it.

Use an image-capable model. Codex [omits images on text-only models][codex-images]
and may resize or reject oversized/unprocessable images during preparation.
Native content support does not guarantee an image preview or file download in
every client UI. The opaque `generated-image:<UUID>` value is an edit reference,
not a downloadable URL or a client-local path. Re-upload base64 image data when
a reference expires or its retained file becomes unavailable.

Client configuration and conversion facts were source-checked for OMP 18.8.9
and Codex CLI 0.161.0/0.162.1; this does not claim a live remote client round-trip
or successful generation with a particular model/provider.

[omp-image-tool]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/tools/image-gen.ts
[omp-mcp-config]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/docs/mcp-config.md
[omp-timeout]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/mcp/timeout.ts
[omp-image-bridge]: https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/mcp/tool-bridge.ts#L198-L300
[codex-mcp]: https://developers.openai.com/codex/mcp
[codex-config]: https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/config/src/mcp_types.rs
[codex-image-conversion]: https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/protocol/src/models.rs#L2314-L2430
[codex-images]: https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/core/src/mcp_tool_call.rs#L946-L962

## Setup

Use **Bun 1.4.2**, matching `packageManager` and `engines` in `package.json`.

```sh
bun install --frozen-lockfile
bun run check
```

`bun install --frozen-lockfile` automatically runs the root `prepare`, which applies
the Effect compiler patch to TypeScript only:
`effect-tsgo patch --typescript --no-oxlint`. Preparation is idempotent. If lifecycle
scripts are skipped, prepare explicitly before checking:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run prepare
bun run check
```

`.github/workflows/quality.yml` runs on `pull_request` and pushes to `main` with
one Linux `quality` job and read-only `contents: read` permissions. Checkout does
not persist credentials. `setup-bun` reads the exact `bun@1.4.2` `packageManager`
from `package.json`; the job then uses the same frozen install and `bun run check`
shown above, without fixes or a separate CI policy.

The committed `bun.lock` and exact dependency pins define the reproducible set:

| Dependency                  | Version |
| --------------------------- | ------- |
| `effect`                    | 4.0.2   |
| `@effect/platform-bun`      | 4.0.2   |
| `@oh-my-pi/pi-ai`           | 18.8.9  |
| `@oh-my-pi/pi-coding-agent` | 18.8.9  |
| `@oh-my-pi/pi-utils`        | 18.8.9  |
| `@effect/vitest`            | 4.0.2   |
| `vitest`                    | 5.0.3   |
| `vite`                      | 8.3.4   |
| `@effect/tsgo`              | 0.51.1  |
| `typescript`                | 7.0.2   |
| `@types/bun`                | 1.4.2   |
| `oxlint`                    | 1.87.0  |
| `@oxlint/plugins`           | 1.87.0  |
| `oxfmt`                     | 0.72.0  |

The transitive `@effect/platform-node-shared` is overridden to **4.0.2** so its
Effect peer matches the root pin; its newer 4.0.3 release requires Effect 4.0.3.

Oxlint and `@oxlint/plugins` were queried from the registry during installation and
pinned together. Upgrade them together. The TypeScript/Effect compiler pair was
verified by successful patching and real diagnostics, not just package metadata.

Upgrade `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-coding-agent`, and `@oh-my-pi/pi-utils`
to the same exact version together with the host OMP CLI. Regenerate `bun.lock`
with `bun install` and review the resulting pin/lock changes before deployment;
subsequent installs must use `--frozen-lockfile`. Keep `effect`,
`@effect/platform-bun`, `@effect/vitest`, and the
`@effect/platform-node-shared` override aligned together rather than independently
upgrading their coupled runtime/peer dependencies.

## Public commands

| Command              | Behavior                                                         |
| -------------------- | ---------------------------------------------------------------- |
| `bun run start`      | Serve loopback authenticated MCP using startup environment       |
| `bun run prepare`    | Patch TypeScript only                                            |
| `bun run typecheck`  | Strict TypeScript and Effect compiler diagnostics, no emit       |
| `bun run lint`       | Standalone Oxlint, no fixes                                      |
| `bun run format`     | Oxfmt verification only, no writes                               |
| `bun run test`       | Vitest run, explicitly forced onto Bun via `bun run --bun`       |
| `bun run check`      | Format verification, lint, typecheck, then test; stop on failure |
| `bun run lint:fix`   | Explicit opt-in lint fixes                                       |
| `bun run format:fix` | Explicit opt-in formatting writes                                |

Ordinary checks never fix files, whether they succeed or fail. Fix commands can
change authored files; review those changes. Oxfmt does not add the blank lines
required by the readability rule or sort import members: use `lint:fix` for those
fixes, followed by `format:fix` and `check` as needed.

## Policies and coverage

`tsconfig.json` uses the published Effect compiler schema and the embedded
`@effect/language-service` plugin with **upstream diagnostic defaults**. There is
no custom severity map. Effect errors and warnings both fail typechecking;
suggestions are reported but do not affect exit status. Strict checking includes
unchecked indexed access, exact optional properties, isolated modules, no emit,
ESNext modules, bundler resolution, TypeScript-extension imports, and Bun ambient
types without the browser DOM library.
`skipLibCheck` skips checking dependency declarations, including Effect's
DOM-related RPC declarations; authored source remains strictly checked.

`oxlint.config.ts` and `oxfmt.config.ts` are the authoritative typed `defineConfig`
configurations and genuine compiler inputs. Authored TypeScript, including tests,
is discovered as added; `.github` TypeScript is included explicitly because
TypeScript's ordinary wildcard discovery skips hidden folders. Owned YAML/CI
configuration remains covered by formatting.

Oxlint is not compiler-patched and has no type-aware or type-check mode. Native
correctness checks and portable unused-binding, explicit-any, type-assertion,
import-member sorting, and braces policies are errors. Intentional underscore
unused bindings are allowed. All eighteen generic anti-slop rules, the native
`oxc/no-accumulating-spread` companion, and all five Effect rules are errors.
The native Vitest plugin also enables correctness rules as errors.
`vitest/no-standalone-expect` recognizes `it.effect` and `it.live` as additional
test blocks. This does not make every Vitest rule aware of Effect helpers; in
particular `vitest/expect-expect` does not detect assertion-free `it.effect`.

Effect compiler diagnostics use type information; anti-slop's Effect policies are
AST-based checks for supported patterns, not a second compiler pass. The service
constructor import rule covers relative project imports matching `make<Capital>`;
package-alias imports are **not guaranteed** to be enforced. Tests/specs are
exempted by that upstream rule. Reducer-copy rules do not fully analyze named
callbacks, indirect helpers, or nested accumulator properties; do not infer that
all quadratic reducers are rejected.

Formatting uses semicolons, double quotes, arrow parentheses only when required,
all trailing commas, and width eighty. Import declarations are sorted
case-sensitively into built-in, scoped-package, external, relative, and remaining
groups; import-member ordering belongs to lint. Package-manifest key order is
preserved. No workspace aliases or reference-application groups are introduced.

Named agent directories (`.agent`, `.agents`, `.claude`, `.codex`, `.continue`,
`.cursor`, `.gemini`, `.opencode`, `.pi`, `.roo`, `.windsurf`), `AGENTS.md`,
`CLAUDE.md`, `docs/agents`, `skills-lock.json`, and vendored anti-slop are protected
from lint/format checks and fixes. Equivalent TypeScript discovery exclusions
protect agent/vendor source. Configurations refer to plugin paths as strings,
without importing vendored source into the compiler graph. Dependencies are
excluded and ignored by Git. No blanket dot-directory exclusion hides owned
configuration. If adding authored TypeScript in another hidden directory, include
it explicitly in `tsconfig.json`.

## Vendored anti-slop provenance

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), verified commit
[`e6676e8d0bf17c678cb45b9dacb2bd6ca8dea53a`](https://github.com/dmmulroy/anti-slop/commit/e6676e8d0bf17c678cb45b9dacb2bd6ca8dea53a).
The recoverable asset snapshot is
[`skills/install-anti-slop/assets/anti-slop/`](https://github.com/dmmulroy/anti-slop/tree/e6676e8d0bf17c678cb45b9dacb2bd6ca8dea53a/skills/install-anti-slop/assets/anti-slop)
(Git tree `a7831feb0c097943ac813ddcb1367e26eef52da5`). This identity was verified
against the actual local assets, not inferred from current upstream HEAD or a
skill-lock hash.

The fresh install ran the original repository-local installer
`/home/fnd/GIT/omp-images-mcp/.agents/skills/install-anti-slop/scripts/install.mjs`
from the tooling worktree, without force. Its source assets were
`/home/fnd/GIT/omp-images-mcp/.agents/skills/install-anti-slop/assets/anti-slop/`;
the installed destination is `tools/oxlint/anti-slop/`. All 38 copied asset files
matched that verified source byte-for-byte. A second installer invocation refused
the existing destination. Preserve local choices and follow the skill's update
procedure for future updates; never force a replacement casually.

The pristine asset SHA-256 manifest digest is
`9050bd7830cd83b9ff9c3540b84ba0b74896a7f457a0d993b60cab59436faa3c`.
Its encoding is lexicographically sorted asset-relative paths, each line
`SHA256 + two spaces + path + LF`, including the final LF.

**Only consumer deviation:** the installer bundle omitted anti-slop's root MIT
notice. `tools/oxlint/anti-slop/LICENSE` was added verbatim from the same immutable
commit ([source](https://github.com/dmmulroy/anti-slop/blob/e6676e8d0bf17c678cb45b9dacb2bd6ca8dea53a/LICENSE));
SHA-256 `10ed33bf340d6d63dc0633dfc917a346b369b6aa41fe20734aefc6a3fb75ba17`.
No rule source was changed.

The nested `vendor/eslint-stylistic/LICENSE` and `UPSTREAM.md` are preserved
unchanged. They describe the separately licensed Stylistic snapshot
`435c3ea0fd26a5fef9042c4b36b6e165fbbf8d08` and its existing Oxlint adaptation.
Their upstream test and pnpm references are inherited provenance, not tests run
in this Bun package.

## Original tooling setup evidence

Temporary CLI smoke inputs proved frozen installation and manual preparation,
strict type failures, real typed configuration failures, default Effect error
`floatingEffect` (TS377001), warning `effectGenUsesAdapter` (TS377027), and
non-blocking suggestion `syncToSucceed` (TS377103). Native correctness, both
accumulator-copy policies, representative generic rules, and all five Effect
rules produced error diagnostics and failed lint and the aggregate. Corrected
counterparts passed. Portable lint policies and owned `.github` source/YAML
coverage were also exercised.

Formatting verification left failing input unchanged. Explicit lint/format fixes
converged, preserving documentation attachment and overload grouping, while
protected agent/metadata fixtures and vendored assets remained byte-identical.
Original repository agent assets were unchanged. Every temporary input was
removed. These results describe the original tooling-only setup, before the
permanent service and test suite were added; they are not evidence of a hosted CI
run. The workflow configuration does not establish hosted success; that requires
a successful GitHub Actions run.
