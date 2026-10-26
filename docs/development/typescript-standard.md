# TypeScript Development Standard

**Applies to**: any TypeScript frontend, service, or tool in this repository
(`src/**` and root frontend manifests). Like the root `AGENTS.md`, this file is
written in English for agent interoperability.

**Last reviewed**: 2026-09-29

## Required Reading

- [Software Engineering Standard](software-engineering-standard.md) — the
  repository-wide baseline for size, module boundaries, dependency direction,
  abstractions, patterns, testing, and exceptions.
- The TypeScript Handbook (typescriptlang.org) — the official language and
  type-system reference.
- Google TypeScript Style Guide — naming, module, type-system, and formatting
  conventions (named exports only, `const`/`let` over `var`, structural
  typing, avoiding `any`, etc.).

## Baseline Practices

- Format with the project's configured formatter and lint with its configured
  linter (`npm run lint`); do not hand-format around them.
- The configured formatter is Prettier: `npm run format` applies it and
  `npm run format:check` reports deviations without modifying files
  (non-zero exit on findings). Configuration lives in `.prettierrc.json`
  with ignore rules in `.prettierignore`; both are versioned so a clean
  install formats reproducibly without private editor settings.
- Formatting and linting are separate responsibilities: Prettier owns
  whitespace, quotes, semicolons, and line wrapping; ESLint owns code
  quality rules through `eslint.config.js`. Do not disable ESLint
  formatting-adjacent rules one by one to fight Prettier — adjust the
  shared Prettier configuration instead. The Rust backend (`src-tauri`)
  is formatted by `cargo fmt` and stays outside Prettier's scope.
- All code must pass type checking with the project's configured `tsc`
  settings (`npm run build`); do not suppress errors with
  `@ts-ignore`/`@ts-expect-error` without an explanatory comment.

### Structured Diagnostics

Frontend warnings and errors use `src/diagnostics.ts` (issue #686). Callers
bind an explicit `WARN`/`ERROR` level, domain `target`, and stable machine
`code` with `createDiagnostic`; dynamic codes use `reportDiagnostic`.
The common record uses the same `level`, `target`, and `message` field names
and uppercase level values as the Rust host sink, with an additional `code`.

The console keeps the original prefix as its first argument and every
original context argument in its original position. The final argument is
the common record, whose `message` equals that prefix. Existing structured
payloads keep their own `message`, `code`, `region`, source and stack fields;
Error objects and other context retain their references. Do not stringify,
copy, inspect or flatten arbitrary context to build a record. The sink uses
the matching console level at emission time; creating a reporter is silent.
The browser object channel preserves rich context while the Rust host writes
JSON to stderr; this does not add a frontend file transport or filter setting.

Production code must not call `console.warn` or `console.error` directly
outside the shared sink. `src/diagnostics.contract.test.ts` checks direct
named console calls through the TypeScript AST. Diagnostics do not replace
visible failure feedback or change the owner's retry, cancellation or
rethrow behavior.

### Strict Type Check Entry

(Issues [#230](https://github.com/hailingu/PlotWeave/issues/230) and
[#231](https://github.com/hailingu/PlotWeave/issues/231), implemented.)
Production source is checked beyond the `strict` baseline by an independent
entry: `npm run typecheck:strict` runs `tsc --noEmit -p tsconfig.strict.json`,
which `extends` the base `tsconfig.json` and adds exactly one flag on top of
it — `noUncheckedIndexedAccess`. The other flag discussed below,
`exactOptionalPropertyTypes`, is not an increment of `tsconfig.strict.json`:
it is enabled in the base `tsconfig.json` itself, so it applies to the main
build and to every entry derived from that base. `scripts/check-static.sh`
invokes the strict entry alongside Prettier and ESLint so the local Git gate,
the Sonar gate, and CI (`ci.yml`) all reject violations before coverage
generation.

The same command also runs `tsc --noEmit -p tsconfig.scripts.json`
(issue [#855](https://github.com/hailingu/PlotWeave/issues/855)). This separate
program checks all non-test `scripts/**/*.ts`, including test facilities,
with Node types, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
Its ES2023 library matches the pinned Node runtime; DOM libraries remain
available because the browser import probe and its frontend imports are
also compiled. Runtime scripts tests retain their existing behavior-test
coverage. `scripts/static-tooling-config.test.ts` uses the compiler config
parser to guard the complete non-test script inventory.

Production `scripts/**/*.mjs` uses ESLint's recommended JavaScript rules
with Node globals (issue [#856](https://github.com/hailingu/PlotWeave/issues/856)).
The same configuration guard verifies an undefined identifier is rejected
for every existing script and a future nested script path.

- **`noUncheckedIndexedAccess`** (#230): Record and array index reads carry
  `undefined` at the type level.
- **`exactOptionalPropertyTypes`** (#231): an optional property declared
  `?: T` no longer accepts an explicit `undefined` — "absent" and "explicitly
  undefined" are distinct, so every optional field states which side of that
  line it is on.
- **Scope**: all production source under `src/` plus the root Vite build
  configs `vite.config.ts` and `vite.native-canvas.config.ts`, and the
  compile-time contract probes `src/**/*.test-d.ts` (these are excluded
  from the main build via `tsconfig.json` `exclude` and compiled only by the
  strict entry — probe assertions evaluate differently under the flags).
  **Out of scope**: `*.test.ts` / `*.test.tsx` — test fixtures build values
  locally where shapes are known by construction; the strictly mechanical
  widening pass there is large and low-value, while production code is where
  dirty data and missing keys matter. Test files stay on the plain `strict`
  baseline: `src/**` runtime tests arrive through the `src` include, and the
  root-level `vite.native-canvas.test.ts` through an explicit `tsconfig.json`
  include entry; `tsconfig.strict.json` declares its own `include` (it
  overrides rather than merges the base), so the root runtime test is simply
  absent there. Issue [#806](https://github.com/hailingu/PlotWeave/issues/806)
  brought both root native-canvas files into these entries after neither
  `tsc` entry had compiled them; the first pass surfaced a latent
  `publicDir: false` widening in the function-form `defineConfig` (a
  zero-parameter factory is not context-sensitive, so its returned literal
  lost contextual typing under the overloads), fixed by an explicit
  `UserConfig` return type. `scripts/tsconfig-scope.test.ts` pins both file
  sets through TypeScript's own config parser, root-level entries included,
  so a regression of either include list fails `npm test`.

**Satisfying the index-access check** (#230): for values that can genuinely be
missing, handle the missing case explicitly with the same dirty-data
semantics the surrounding code already uses. For locally proven invariants,
express them in the type system or control flow instead: finite-key
`Record<Union, V>` maps (`SettingsBuckets`, `AiWriteOp`, `AiNodeFieldType`),
snapshot value iteration (`Object.entries`) instead of key-then-index reads,
and extracting the single hit (`const hit = xs.length === 1 ? xs[0] :
undefined`) before use. Loop-bound-guarded index reads may use `?.` or a
fallback with a comment stating why the branch is unreachable. Do not
blanket-add `!` or `as` casts; the one accepted compensation is casting
`Object.keys` of a finite-key record back to its key union (single source of
truth for the key set), with a comment.

**Satisfing the optional-property check** (#231):

- Forbidden-mirror fields (`label?: never` and friends on `ShotRef`,
  `DerivedMeta`, `ShotMeta`, `ImageMeta`) must stay `?: never` with **no**
  `undefined` added — rejecting explicit `undefined` is precisely their
  contract, asserted by `src/model/typeContracts.test-d.ts`.
- Legal clearing channels are typed explicitly instead of widening the domain
  shape: `PatchShape` allows `T[K] | undefined` per field and drops
  `never`-mirror keys from the patch surface; `LinePatch` does the same for
  dialogue-line patches (`episodeNoPatch`, speaker/side clearing).
- Construction sites that mean "field absent" use conditional spread
  (`...(v !== undefined && { field: v })`) — e.g. new-node factories omit
  `speaker` rather than writing `undefined` into a `DialogueLine`.
- Optional fields that legitimately receive explicit `undefined` declare
  `?: T | undefined` with a comment naming the meaning: UI callbacks
  (undefined = not wired; React treats it as absent), passthrough/persistence
  shapes (undefined = absent; serialization strips it), and library-shape
  accommodations (xyflow `Edge`/`ReactFlowProps` members already carry
  `| undefined`; call sites use conditional spread for props we cannot
  widen).

### Type-Aware Lint Entry

(Issue [#357](https://github.com/hailingu/PlotWeave/issues/357),
implemented.) ESLint parses production source with full type information
(`parserOptions.projectService` bound to `tsconfig.json`) and enforces
`@typescript-eslint/no-floating-promises` and
`@typescript-eslint/no-misused-promises` at `error` severity — the
fire-and-forget convention below is executed by the linter instead of review
alone. `npm run lint` and
`scripts/check-static.sh` run it with zero-warning semantics, so the local
Git gate, the Sonar gate, and CI all reject violations.

- **Fire-and-forget marking**: an intentionally unhandled promise is marked
  with the `void` operator at the call site (`void store.save()`), and only
  when the callee owns an internal error channel (try/catch, `.catch`
  fallback, or outcome-object return) so silence cannot swallow a failure.
  Any other promise must be awaited or carry a rejection handler.
- **Void-return boundaries**: an async function must not be passed where a
  `() => void` callback is expected (React props, event listeners without a
  promise-returning contract, retry closures); wrap it in a sync function
  that void-marks the call, e.g. `onClick={() => void save()}`.
- **Scope**: production source under `src/`. Out of scope for now —
  `*.test.ts` / `*.test.tsx` and the `*.test-d.ts` contract probes stay on
  the non-type-aware baseline (same shape as the strict type check entry
  above; enabling there is a separate batch, issue #357).
- The wider type-aware families (`recommendedTypeChecked`, `no-unsafe-*`)
  stay un-enabled pending a zero-warning evaluation (issue #357).

The permanent configuration guard
[`scripts/eslint-type-aware.test.ts`](../../scripts/eslint-type-aware.test.ts)
(issue [#437](https://github.com/hailingu/PlotWeave/issues/437), implemented)
uses ESLint's `calculateConfigForFile` API to inspect the effective merged
configuration for root and nested production TS/TSX paths. It requires
`projectService` to be enabled and both Promise rules to remain at `error`
severity, and verifies that test files, contract probes, and tools outside
`src/` retain the non-type-aware baseline. These path probes require no
temporary source files. Removing or downgrading the block, disabling the
type service, or changing these scope boundaries makes `npm test` fail;
the guard does not assert configuration source text or documentation prose.

### Quality Report Classification

(Issue [#311](https://github.com/hailingu/PlotWeave/issues/311),
implemented; extended by issue
[#343](https://github.com/hailingu/PlotWeave/issues/343).) Sonar analysis
and frontend coverage report **production code**; test infrastructure
stays analyzed but outside the product statistics.
`sonar-project.properties` classifies code through the officially
supported combination of source exclusion plus test inclusion:
`sonar.test.inclusions` covers `*.test.ts` / `*.test.tsx`, the
compile-time contract probes `*.test-d.ts` (still compile-checked by the
strict entry), and modules that exist only for tests — `src/moduleGraph.ts`
(architecture guard), `src/styles/cssColorContract.ts`,
`src/styles/cssValueSyntax.ts`, `src/styles/sheetRuleQuery.ts`, and
`src/styles/sheetTokensEngine.ts` (CSS contract engine; `sheetRuleQuery.ts`
added by issue #343 after the engine split), plus
`src/styles/sheetTokenCaseMatrix.ts` (shared case-data tables that
single-source the sheetToken contract fixture matrices previously duplicated
across four test files, added by issue
[#538](https://github.com/hailingu/PlotWeave/issues/538)),
`src/model/convertFixtures.ts`
and `src/editor/ai/testGraphs.ts` (shared test fixtures),
`src/editor/nodes/testScaffolding.tsx` (shared scaffolding for the node
component tests: Handle stub factory and `NodeEditApi` builder, added by
issue [#534](https://github.com/hailingu/PlotWeave/issues/534)),
`src/editor/panels/testDomStubs.ts` (shared happy-dom DOM stubs for panel
tests, added by issue
[#539](https://github.com/hailingu/PlotWeave/issues/539)), and
`src/appShellTestScaffolding.tsx` (shared stub modules, fixtures, and
open/settings-roundtrip helpers for the App shell test files split out of
the former `App.test.tsx`, added by issue
[#525](https://github.com/hailingu/PlotWeave/issues/525), plus the shared
`console.warn` lifecycle those files use — expected warnings are declared
per case and undeclared warnings fail the test with the captured output,
issue [#542](https://github.com/hailingu/PlotWeave/issues/542)).

`src/projectStoreTestHarness.ts` adds the shared typed IPC interception, owned
fake clock, and cleanup for projectStore Tauri tests (issue
[#600](https://github.com/hailingu/PlotWeave/issues/600)). The same
list is
mirrored into `sonar.exclusions` — moving these files out of
product-source statistics while they remain analyzed as test code, not a
blanket exclusion that hides findings — and into the vitest coverage
`exclude` in `vite.config.ts`, so `coverage/lcov.info` contains product
files only. `scripts/sonar-test-scope.test.ts` guards this classification
contract by applying SonarQube path-pattern semantics to the properties
file, mirroring the list against the vitest coverage `exclude`, and —
since issue #343 — enforcing the classification in both directions: a
maintained module whose importers are all test facilities or test files
must be classified, and a classified facility that gains a
production-side importer must be removed from the facility list. The
reverse import graph reuses `moduleGraph`'s AST edge resolution, includes
`*.test.ts(x)` imports across the vitest test directories (`src/` and
`scripts/`) parsed with each file's own syntax (`ScriptKind.TSX` for
`.tsx`), and treats both value and type-only edges as evidence — any
production-side import (value or type) anchors a module in product source,
while a module whose entire importer set is test facilities or test files
(type or value, `*.test-d.ts` probes included) must be classified. The
vitest coverage `exclude` is
additionally checked in reverse: no exclude pattern may match a maintained
module outside the facility list, so a broad pattern cannot silently drop
product coverage. The zero-importer production entries
`src/bootstrap.ts` and `src/main.tsx` are exempted as product roots —
`index.html` loads bootstrap directly, and bootstrap pulls in the
application via a dynamic import, so the dynamic edge is by design
outside the static importer graph (issue #358 review 4111703403) — so
splitting a support
module out of a test facility can no longer escape classification, and a
facility absorbed back into product code can no longer stay excluded from
product statistics.

### Coverage Floor And Baseline

(Issue [#393](https://github.com/hailingu/PlotWeave/issues/393), implemented.)
The frontend coverage floor is versioned and failable. `vite.config.ts` sets
vitest `coverage.thresholds` to **80% overall line coverage** (global), so `npm run test:coverage` exits non-zero the moment coverage
drops below the floor — before any Sonar analysis runs. The value
deliberately matches the local SonarQube server's Quality Gate coverage
condition (80%, owner decision 2026-09-29) instead of tracking the measured
baseline: the server-side condition is not version-controlled, and this
floor is its repo-side equivalent. `scripts/sonar-quality-gate.sh` re-checks
both LCOV reports (frontend and Rust) against the same 80% floor on the same
`DA` line-hit basis the scanner imports and the gate ledger records
(`frontendLineCoveragePercent`); exactly 80% passes — the floor comparison
uses unrounded hit counts (`covered × 100 ≥ total × floor`), so a true ratio
just below the floor that would round to a displayed `80.00%` is still
rejected, and rounded percentages remain display- and ledger-only —
mirroring the server's "below the condition fails" semantics.

Measured coverage varies with the inspected tree and is not a fixed baseline.
Assess headroom using the LCOV report (`coverage/lcov.info`) from the run being
assessed and the per-run summaries in [gate-history.jsonl](gate-history.jsonl).
The ledger contains executor-reported summaries, not independent proof of
execution; its boundaries and verification procedure are documented in
[Gate Run Evidence Record](quality-gate-evidence.md#gate-run-evidence-record-issue-355).

Boundaries: only **line** coverage has a floor — branch metrics have none on
either side of the stack (the Rust report has no branch metric on the pinned
stable toolchain; see
[rust-standard.md](rust-standard.md) "Test Coverage" for the Rust baseline,
the 80% floor shared by both reports, and that boundary). The floor must not
be met by widening `coverage.exclude`: `scripts/sonar-test-scope.test.ts`
guards the exclusion list bidirectionally and pins the threshold value, so
removing the floor or changing its value without review fails `npm test`.

#### Native Canvas Per-File Lines (Issue #616)

Every production `.ts`/`.tsx` module under `src/editor/nativeCanvas/` also requires **80% line coverage independently**, while the aggregate floor remains 80%. `scripts/native-canvas-coverage.ts` discovers the actual tree at configuration resolution, including new modules, and emits one exact-path threshold group per source. Test files and declaration-only files are outside product runtime coverage; there are no historical low-floor exceptions or new product exclusions.

The pinned Vitest 5.0.5 retains one exact-path group per source, using the provider's glob thresholds; each group therefore contains exactly one file. Unlike Vitest 4, glob groups no longer inherit the top-level `perFile` setting, and include/exclude patterns match paths relative to the project root. The existing global floor, source inventory, and product/test exclusions remain unchanged after the #761 migration. Do not replace these groups with a directory aggregate that can absorb one low file. `scripts/sonar-test-scope.test.ts` guards the complete maintained-source inventory and the unchanged global floor; the discovery tests cover new files and literal glob paths. A real-provider boundary probe must establish that 80% in one native canvas file passes and 60% fails even with high aggregate coverage when changing provider generations.

`npm run test:coverage -- --maxWorkers=4` and the mandatory fresh frontend coverage in local Git gates enforce these file floors. CI retains its existing `npm test` entry: it executes the configuration guard and behavior tests, without collecting coverage itself. Sonar's LCOV re-check and reused-report paths still enforce the overall 80% condition; they do not independently recompute the new per-file policy. Other frontend directories retain their existing aggregate-only policy.

The initial full V8 run after adding this policy passed all behavior tests and measured 96.95% aggregate lines, yet correctly failed `NativeHostApp` (0%), `main` (77.77%), `nativeEditorActions` (71.42%), and `useNativeEditorShell` (66.66%). Behavior tests cover real entry lifetime, native graph/settings/episode commands, undo and rejected arguments to bring those files above the floor. No production runtime behavior changes or coverage exclusion changes are required.

The complete follow-up run passed 246 files / 3416 tests at 97.47% aggregate lines. The four files measured 100% (`NativeHostApp`), 100% (`main`), 92.86% (`nativeEditorActions`), and 88.46% (`useNativeEditorShell`). An isolated real-provider boundary probe used the same global floor and source-inventory policy: one file at 80% with 98.18% aggregate passed; at 60% with 96.36% aggregate it failed. This probe tests the threshold contract, not physical host behavior; the entry/controller cases use browser DOM, and no new visual, VoiceOver, or real IME acceptance is claimed.

#### Scripts Tooling Per-File Floors (Issue #726)

Gate-critical production TypeScript under `scripts/` now has failable line-coverage floors instead of relying on test discipline alone. `vite.config.ts` adds `scripts/**/*.ts` to `coverage.include`, and `scripts/scripts-coverage-floor.ts` registers one exact-path threshold group per in-process-testable production file: `gate-scope-core.ts` and `native-canvas-coverage.ts` at 80 (the generator module itself is also registered at 80, executed in-process through `vite.config.ts`), and `native-coverage.ts` at a recorded starting floor of 50 (issue #726 permits starting below 80; measured 53.84% at dev `9e2d89b1`) — the aggregate 80% floor and the native-canvas groups are unchanged.

The registered-list (not directory-discovery) design exists because most `scripts/` production files are driven by tests as spawned child processes (`check-file-size.ts`, `check-workspace-drift.ts`, `gate-scope.ts`, `verify-gate-evidence.ts`, the three `pre-push-install*.mjs` CLIs): V8 in-process coverage cannot observe child processes, so auto-flooding them at 80% would fail immediately and counting them at 0% would pollute the aggregate with instrumentation blindness rather than test absence. Those files are excluded from coverage and instead carry a **test-driver-evidence guard**: `scripts/scripts-coverage-scope.test.ts` fails unless every production `.ts`/`.mjs` under `scripts/` is classified (floored, subprocess-driven, or test facility per the #311 policy: the probe/fixture pair `build-library-import-probe.ts` + `scripts/fixtures/**`, `gate-routing-probe.ts`, `git-scenario-fixture.ts`, `native-coverage-fixture.ts`), registry entries are dangling, or a floored/subprocess file loses its last referencing test. Deleting all tests of any production file therefore fails either `npm run test:coverage` (floored files) or `npm test` (the guard, which also runs in CI), satisfying issue #726's acceptance; the same guard pins the include/exclude classification against the vite config.

Residual boundaries, recorded rather than fixed: subprocess-driven files' actual line coverage remains unmeasured (V8 blindness; their behavior is integration-tested through the spawned CLI), and `scripts/**/*.sh` plus `.githooks/**` shells stay outside this policy pending the separate owner decision issue #726 reserves for them. Sonar scope is unchanged: static analysis of `scripts/**` rests on the zero-warning ESLint gate in `scripts/check-static.sh` (which covers the whole repository), and adding `scripts` to `sonar.sources` is deliberately not taken here — a first analysis would mark ~5k existing lines as new code under the zero-new-issue gate, which needs its own owner decision. The LCOV report now contains the floored `scripts/*.ts` files; Sonar ignores report entries outside its analyzed sources.

## TypeScript Engineering Practices

- Organize frontend and service code by feature or domain capability. A feature
  owns its components or handlers, state, application logic, tests, and public
  entry point; shared infrastructure must have a named responsibility.
- Keep UI components focused on rendering and interaction. Move reusable domain
  policy and external I/O into feature services, hooks, or adapters; split a
  component along independent state or behavior boundaries, not markup count
  alone.
- Keep route, framework, transport, and generated API types at their
  boundaries. Validate unknown external input (including IPC payloads from the
  Rust backend) and translate it into domain types before core use.
- Prefer functions, discriminated unions, and composition. Introduce classes,
  interfaces, factories, or dependency containers only when state ownership,
  lifecycle, meaningful variation, or an external boundary requires them.
- Avoid barrel exports that create cycles or unintentionally widen a package's
  public API. Cross-feature imports must use the owning feature's explicit
  public entry point.
- Use named exports only in application code under `src/` (per the Google
  TypeScript Style Guide reference above;
  [issue #164](https://github.com/hailingu/PlotWeave/issues/164),
  implemented). `React.lazy` assembly is not a reason to keep a default
  export: map the named export at the assembly point, e.g.
  `lazy(() => import('./EditorView').then((m) => ({ default: m.EditorView })))`.
  Root tool configuration entry points are outside this rule and keep the
  export shape their tool contract requires — `vite.config.ts` and
  `eslint.config.js` default-export their config objects by tool mandate.
- Distinguish browser (Tauri webview) and shared modules so
  environment-specific dependencies cannot leak across runtime boundaries; the
  browser-memory persistence fallback must stay behaviorally aligned with the
  Tauri path.

## Before Writing Code

Read this file, then inspect the target package for existing component, hook,
state-management, store-client, runtime-boundary, and test patterns. Reuse
compatible capabilities instead of introducing a parallel approach, and apply
the common size and complexity review triggers.
