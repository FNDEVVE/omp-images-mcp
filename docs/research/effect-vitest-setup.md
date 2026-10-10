# Effect Vitest setup facts

Research date: 2026-10-10. These are factual prerequisites for adding tests to this Bun 1.4.2 / TypeScript 7.0.2 / `effect@4.0.2` package. They are not a setup decision.

Evidence labels: **Evidence** means registry metadata, pinned source, or a command observed in the throwaway trial. **[INFERENCE]** marks a conclusion that was not observed directly. The trial was a throwaway Bun project. Its `compilerOptions` matched this repository, and it included the TypeScript patch from `@effect/tsgo@0.51.1`. It ran in `/dev/shm` because `/tmp` hit its per-user quota (`EDQUOT`). It has been deleted, and nothing was installed into this repository.

## Versions and compatibility verdict

| Package          | Version                                                                                  | Relevant metadata                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest`         | **5.0.3** (`latest`, published 2026-09-30)                                               | `engines.node: ^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`; required peer `vite: ^6.4.0 \|\| ^7.0.0 \|\| ^8.0.0`; bin `#!/usr/bin/env node` [R1], [V1] |
| `vite`           | **8.3.4** (`latest`)                                                                     | `engines.node: ^20.19.0 \|\| >=22.12.0` [R2]                                                                                                    |
| `@effect/vitest` | **4.0.2** (published 2026-10-07)                                                         | peers `effect: ^4.0.2`, `vitest: >=5.0.0 <6.0.0`; package devDependency `vitest: 5.0.3` [R3], [P1]                                              |
| `@effect/vitest` | 4.0.3 (`latest`, published 2026-10-10)                                                   | peers `effect: ^4.0.3`, `vitest: >=5.0.0 <6.0.0` [R4]                                                                                           |
| `effect`         | 4.0.2 (`latest`); **4.0.3 returns 404 on npm** even though Git tag `effect@4.0.3` exists | [R5], [G0]                                                                                                                                      |

**Verdict (Evidence):** `vitest@5.0.3` + `vite@8.3.4` + `@effect/vitest@4.0.2` + `effect@4.0.2` is compatible. Vitest 5 compatibility is declared by `@effect/vitest@4.0.2`'s peer range [R3] and its README ("Install Vitest 5 (`>=5.0.0 <6.0.0`)") [P2 L7-13]. Effect's own repository tests this combination: at the `@effect/vitest@4.0.2` tag it pins `vitest ^5.0.3`, `vite ^8.3.2`, and `typescript ^7.0.2` [G3 L78-80]. In the trial, `vitest run` passed 5/5 Effect tests on both Node and Bun.

**Mismatch (Evidence):** the current `latest` `@effect/vitest@4.0.3` requires `effect ^4.0.3`, which is not published on npm. When added in the trial, `bun add` printed `warn: incorrect peer dependency "effect@4.0.2"` and continued. `4.0.2` is therefore the release that pairs with the pinned `effect@4.0.2`.

**Provenance:** published `package.json` names `https://github.com/Effect-TS/effect.git`, directory `packages/vitest` [P1 L8-12]. Release tags `effect@4.0.2` and `@effect/vitest@4.0.2` both point to commit `269a7c864351231d42e6e95b7fa8f32050df3691` in `Effect-TS/effect` [G0]. All Effect repository citations below use that commit. `Effect-TS/effect-smol` still exists, but it is not the release source named by the published package.

## Runtime: Node versus Bun

- **Evidence:** Vitest declares only Node engines [R1]. Its docs say "Vitest requires Vite >=v6.4.0 and Node >=v22.12.0". They list `bun add -D vitest` as an install command, but do not claim Bun runtime support [D1 L40-52].
- **Evidence:** the `vitest` bin starts with `#!/usr/bin/env node` [V1]. Bun respects that shebang by default; `--bun` forces Bun's runtime for that CLI [B1 § `--bun`].
- **Evidence (trial):** `"test": "vitest run"` invoked through `bun run test` ran in **Node v24.21.0** (the local `node`). `bun --bun vitest run` and `bun run --bun vitest run` ran in **Bun 1.4.2**. All three passed the same 5 tests.
- **Evidence:** Effect's CI has a Bun matrix entry that runs `bun run --bun vitest run --max-concurrency=10` with Bun 1.4.0. The Node entry runs `pnpm test` [G6 L128-139]. Effect's config also excludes some `effect` tests under Bun because they "assert Node-specific Web API or stack trace behavior" [G1 L91-105].
- **Evidence:** the docs warn that `bun test` runs Bun's own test runner. Use `bun run test` instead [D1 L110-112].
- **Evidence:** this repository's CI uses `ubuntu-latest` with `setup-bun` and no explicit Node setup (`.github/workflows/quality.yml`). Runner image Ubuntu 24.04 version 20261004.327.1 ships Node.js 22.23.3 [GH1 L11, L26], which satisfies Vitest's engine range. **[INFERENCE]** That assumes `ubuntu-latest` maps to that image. A plain `bun run test` in CI would therefore use that Node. Behavior when `node` is absent from `PATH` was not tested.

## TypeScript 7 and transforms

- **Evidence:** Vitest uses Vite's transform pipeline. Vite 8 transpiles `.ts` with the Oxc Transformer, without type checking [VI1 L33-45]. It requires `isolatedModules: true`, which this repository already sets [VI1 L62-72]. The `esbuild` option is converted to `oxc` internally [VI2 L473-510]. The Vitest runtime does not invoke TypeScript, so the TS 7 compiler is irrelevant to test execution. In the trial, `allowImportingTsExtensions` imports such as `../src/greeter.ts` resolved.
- **Evidence:** Vitest's optional `--typecheck` mode is experimental. It spawns `tsc` by default and parses `tsc`-format output [D6 L6, L26-38]. In the trial, `vitest run --typecheck.only` with `typescript@7.0.2` correctly reported a failing `expectTypeOf` assertion and printed the experimental-feature warning.
- **Evidence (trial):** with `types: ["bun"]`, `tsc --noEmit` from TypeScript 7.0.2, patched by `@effect/tsgo` 0.51.1, type-checked `vitest.config.ts` and the test files under the repository's `include: ["**/*.ts"]`. It produced no TypeScript errors, only the Effect diagnostics below. `@types/bun@1.4.2` depends on `bun-types@1.4.2`, which depends on `@types/node: *`; the trial resolved `@types/node@26.6.5`.

## Strict tsconfig and Effect diagnostics: policy conflict

- **Evidence (trial):** under the repository's Effect language-service setup (upstream defaults, warnings fail `tsc`), every top-level use of `it` or `layer` from `@effect/vitest` emitted `warning TS377136: '@effect/vitest#it' is an unstable API ... effect(unstableApiUsage)`. `tsc` exited 1. Re-exported `assert`, `describe`, and `expect`, plus `TestClock` from `effect/testing`, produced no warning. `@effect/vitest` source marks its exports `@stability unstable` [P3]. In `@effect/tsgo@0.51.1`, `unstableApiUsage` defaults to `"warning"` (local `node_modules/@effect/tsgo/schema.json` L2896-2899).
- **Evidence:** Effect's own `tsconfig.base.json` sets `"unstableApiUsage": "off"` globally [G4 L39].
- **Evidence (trial):** two narrower suppressions worked. Each was confirmed by a later `floatingEffect` error proving the plugin was still active:
  1. a file directive: `// @effect-diagnostics unstableApiUsage:off`;
  2. a plugin path override: `{"name":"@effect/language-service","overrides":[{"include":["test/**/*"],"options":{"diagnosticSeverity":{"unstableApiUsage":"off"}}}]}`. `overrides` is in the tsgo schema (L3103).
- **Conflict:** the README says there is "no custom severity map" and that warnings fail typechecking. Adding `@effect/vitest` tests therefore breaks `bun run check` unless one of these suppressions is adopted. **This is the only blocking issue found.** Choosing a suppression is a decision. The same diagnostic also fires for `effect/ai` `McpServer` (`effect/ai/McpServer#McpServer is an unstable API`), so the MCP source will hit the same issue regardless of tests.
- **Adjacent observation (trial, not re-run in this repository):** importing `{ McpServer } from "effect/ai"` with this repository's `lib: ["ESNext"]`, `types: ["bun"]`, and no `skipLibCheck` also produced six `TS2694: Namespace 'globalThis' has no exported member 'Transferable'` errors. They came from `node_modules/effect/dist/rpc/RpcClient.d.ts` and `RpcServer.d.ts`. These errors do not come from Vitest.
- **Evidence:** Vitest globals are off by default. Using them requires `types: ["vitest/globals"]` [D4 L8, L27-35]. All `@effect/vitest` docs import explicitly (`import { assert, describe, expect, it, layer } from "@effect/vitest"`) [P4], and the package re-exports all of `vitest` [P3 L22]. With explicit imports, the existing `types: ["bun"]` needed no change in the trial.

## `@effect/vitest@4.0.2` API (v4)

Sources: [P3] (public types), [P5] (implementation), [P2] (README), [P4] (shipped ai-docs).

- `it` is Vitest's `it`, proxied with Effect helpers. `it.effect`, `it.live`, `it.layer`, `it.prop`, and `it.flakyTest` exist. Top-level `effect`, `live`, `layer`, `prop`, `flakyTest`, `makeMethods`, `describeWrapped`, and `addEqualityTesters` are also exported [P3 L218-377]. There is no separate `it.scoped` or `it.scopedLive`: both `it.effect` and `it.live` provide a fresh `Scope` closed after each test [P2 L306-308].
- **`it.effect`** runs `Effect.scoped` and then `Effect.provide(TestEnv)`. `TestEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer())` [P5 L59, L386]. `TestClock` starts at 0 and advances only with `TestClock.adjust` [P2 L169-201]; the trial asserted 0. Logging is suppressed by default under `it.effect` [P2 L277-297].
- **`it.live`** runs only `Effect.scoped`, with live clock and console [P5 L387].
- Test signature: `(name, (ctx) => Effect, timeout?: number | TestOptions)`. Modifiers are `.skip`, `.skipIf`, `.runIf`, `.only`, `.fails`, `.each(cases)(name, (case, ctx) => Effect)`, and `.prop` [P3 L40-131]. Failures are logged with `Cause.prettyErrors` and rethrown. Vitest's abort `signal` interrupts the fiber, and finalizers are awaited on abort [P5 L23-54].
- **`layer(L, { concurrent?, memoMap?, timeout?, excludeTestServices? })(name?, (it) => …)`** builds the layer once per block with a memo map. It merges `TestEnv` unless `excludeTestServices` is set. A named block becomes a `describe` with `beforeAll` build and `afterAll` scope close. Nested `it.layer` forks the memo map. The inner `it` is `MethodsNonLive`, which has no `it.live` [P5 L231-358], [P3 L141-209, L288-299].
- **Property tests:** `it.prop` / `it.effect.prop(name, [Schema | Arbitrary, …] | {k: …}, fn, { arbitrary?: Arbitrary.CheckOptions })` use `effect/Arbitrary`, so there is no `fast-check` dependency. Schemas are compiled with `Arbitrary.schema`. Returning `false`, throwing, or failing falsifies the property and triggers shrinking [P5 L81-120], [P2 L77-83].
- **`it.flakyTest(effect, timeout = 30s)`** retries up to 10 times within the timeout and then dies [P5 L361-382].
- **Assertions:** `assert`, `expect`, and the rest come from the `vitest` re-export. `@effect/vitest/utils` adds `assertEquals` (`Equal.equals`), `deepStrictEqual`, `strictEqual`, `assertTrue`, `assertFalse`, `assertInclude`, `assertMatch`, `throws`, `throwsAsync`, `assertNone`, `assertSome`, `assertSuccess` / `assertFailure` (Result), `assertExitSuccess` / `assertExitFailure`, `assertDefined`, `assertUndefined`, and `assertInstanceOf` [P6]. It imports `node:assert` [P6 L19].
- `addEqualityTesters()` calls `expect.addEqualityTesters([])` with an empty list in 4.0.2 [P5 L62-64]. Effect's repository still calls it from a setup file [G2].
- **Fixtures:** `makeMethods(test.extend(...))`. Test callbacks must destructure fixtures [P2 L329-355].
- **Vitest 5 changes surfaced by `@effect/vitest`:** `*.sequential` is removed; use `{ concurrent: false }`. Mock history clears before each test. Async assertions must be awaited. In concurrent tests, use `ctx.expect` [P2 L31-57].

## Config shape facts

- **Evidence:** a typed `vitest.config.ts` uses `import { defineConfig } from "vitest/config"` and a `test` key. Vitest looks for `vitest.config.{ts,mts,cts,js,mjs,cjs}` and then `vite.config.*` in the root, and runs without a config if neither exists [D2 L13-27].
- **Defaults:** `include` is `['**/*.{test,spec}.?(c|m)[jt]s?(x)']`; overriding it replaces the defaults [D3 L8, L59-70]. `environment` is `'node'` [D5 L8]. `globals` is `false` [D4 L8]. `passWithNoTests` is `false` [D7].
- **Effect repository shape:** `defineConfig` from `vitest/config` with `projects`. Shared settings are `include: ["test/**/*.test.{ts,tsx}"]`, `sequence.concurrent: true`, `passWithNoTests: true`, a `setupFiles` entry calling `addEqualityTesters()`, `resolve.tsconfigPaths: true` for workspace `paths`, `coverage.provider: "v8"`, and the `@effect/platform-bun` project only when `process.versions.bun` is set [G1 L57-86, L149], [G2]. Its root script is `"test": "vitest"` [G3 L15]. Its test tsconfig uses `types: ["node"]` and includes `**/vitest.*.ts` [G5 L6, L23].
- **Evidence (trial):** this minimal config passed under Node and Bun:

  ```ts
  import { defineConfig } from "vitest/config";

  export default defineConfig({
    test: { include: ["test/**/*.test.ts"], environment: "node" },
  });
  ```

  Vitest wrote its cache to `node_modules/.vite/vitest`, which this repository's `node_modules/` ignore rule already covers. The docs separately recommend ignoring `.vitest/` for reports and artifacts [D1 L58-63]; the trial did not create one.

## Oxlint facts (repository `oxlint@1.87.0`)

- **Evidence:** native plugin `vitest` is in the plugin enum (`node_modules/oxlint/configuration_schema.json`). `oxlint --rules` lists 73 `vitest` rules, 17 of them in **correctness**: `expect-expect`, `hoisted-apis-on-top`, `no-conditional-expect`, `no-conditional-tests`, `no-disabled-tests`, `no-focused-tests`, `no-standalone-expect`, `prefer-snapshot-hint`, `require-awaited-expect-poll`, `require-local-test-context-for-concurrent-snapshots`, `require-mock-type-parameters`, `require-to-throw-message`, `valid-describe-callback`, `valid-expect`, `valid-expect-in-promise`, `valid-title`, and `warn-todo`. The repository currently enables only `typescript`, `unicorn`, and `oxc`, with `categories.correctness: "error"`. Adding `vitest` would make those 17 rules errors.
- **Evidence (trial):** with the vitest plugin enabled, oxlint does not treat `it.effect(...)` as a test block:
  - `vitest/no-standalone-expect` falsely errors on `expect` inside `it.effect`. Setting `"vitest/no-standalone-expect": ["error", { "additionalTestBlockFunctions": ["it.effect", "it.live"] }]` removed that false positive.
  - `vitest/expect-expect` does not flag an assertion-free `it.effect`. It does flag an assertion-free plain `it` from either `vitest` or `@effect/vitest`.
- **Evidence (trial):** repository rule `anti-slop/no-module-mocking` flags `vi.mock` when `vi` is imported from `"vitest"`. It does **not** flag `vi.mock` when `vi` is imported from `"@effect/vitest"`, because the rule checks only the `"vitest"` and `"@jest/globals"` import sources (`tools/oxlint/anti-slop/rules/no-module-mocking.ts` L30-36).
- **Evidence:** `anti-slop-effect/no-service-constructor-imports` exempts files that match `/\.(?:test|spec)\.[cm]?[jt]sx?$/` (`tools/oxlint/anti-slop/effect/rules/no-service-constructor-imports.ts` L6, L31-35).

## Exact-pin policy and frozen lockfile

- **Evidence (trial):** Bun installs required peers automatically. After adding only `vitest`, Bun resolved `vite@8.3.4` (`rolldown@1.2.13`, `lightningcss@1.33.0`, `postcss@8.5.29`), and `bun.lock` recorded it. `package.json` did not list it. **[INFERENCE]** Under the exact-pin policy, `vite` therefore has no explicit `package.json` pin unless it is added directly; its version is fixed only by the lockfile within the `^6.4 || ^7 || ^8` peer range.
- `@effect/vitest` re-exports `vitest` and declares it as a peer, so `vitest` must also be a direct dependency [P3 L22], [R3].
- **Evidence:** in the trial, `bun add --exact --dev` wrote exact versions. The `prepare` hook reran `effect-tsgo patch` and reported `typescript skipped because its hash matches the replacement`. CI runs `bun install --frozen-lockfile` (`quality.yml` L22), so a dependency addition needs an updated, committed `bun.lock`. No other conflict was found.

## Sources

[R1]: https://registry.npmjs.org/vitest/5.0.3
[R2]: https://registry.npmjs.org/vite/8.3.4
[R3]: https://registry.npmjs.org/@effect/vitest/4.0.2
[R4]: https://registry.npmjs.org/@effect/vitest/4.0.3
[R5]: https://registry.npmjs.org/effect
[V1]: https://unpkg.com/vitest@5.0.3/vitest.mjs
[P1]: https://unpkg.com/@effect/vitest@4.0.2/package.json
[P2]: https://unpkg.com/@effect/vitest@4.0.2/README.md
[P3]: https://unpkg.com/@effect/vitest@4.0.2/src/index.ts
[P4]: https://unpkg.com/@effect/vitest@4.0.2/ai-docs/src/09_testing/10_effect-tests.ts
[P5]: https://unpkg.com/@effect/vitest@4.0.2/src/internal/internal.ts
[P6]: https://unpkg.com/@effect/vitest@4.0.2/src/utils.ts
[G0]: https://github.com/Effect-TS/effect/tree/269a7c864351231d42e6e95b7fa8f32050df3691
[G1]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/vitest.config.ts
[G2]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/vitest.setup.ts
[G3]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/package.json
[G4]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/tsconfig.base.json
[G5]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/tsconfig.tests.json
[G6]: https://github.com/Effect-TS/effect/blob/269a7c864351231d42e6e95b7fa8f32050df3691/.github/workflows/check.yml
[D1]: https://github.com/vitest-dev/vitest/blob/33cadea62e8763c455c7fca38d9ab1dda87c5f75/docs/guide/index.md
[D2]: https://github.com/vitest-dev/vitest/blob/33cadea62e8763c455c7fca38d9ab1dda87c5f75/docs/config/index.md
[D3]: https://github.com/vitest-dev/vitest/blob/33cadea62e8763c455c7fca38d9ab1dda87c5f75/docs/config/include.md
[D4]: https://github.com/vitest-dev/vitest/blob/33cadea62e8763c455c7fca38d9ab1dda87c5f75/docs/config/globals.md
[D5]: https://github.com/vitest-dev/vitest/blob/33cadea62e8763c455c7fca38d9ab1dda87c5f75/docs/config/environment.md
[D6]: https://github.com/vitest-dev/vitest/blob/33cadea62e8763c455c7fca38d9ab1dda87c5f75/docs/config/typecheck.md
[D7]: https://github.com/vitest-dev/vitest/blob/33cadea62e8763c455c7fca38d9ab1dda87c5f75/docs/config/passwithnotests.md
[VI1]: https://github.com/vitejs/vite/blob/b6c20f6a8126d8561891e5fb9368e8fc9da37538/docs/guide/features.md
[VI2]: https://github.com/vitejs/vite/blob/b6c20f6a8126d8561891e5fb9368e8fc9da37538/docs/config/shared-options.md
[B1]: https://bun.com/docs/runtime
[GH1]: https://github.com/actions/runner-images/blob/bdac7c6000c3501174076ad6d6a06ce46871fa71/images/ubuntu/Ubuntu2404-Readme.md
