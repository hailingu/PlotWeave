# TypeScript Development Standard

**Applies to**: any TypeScript frontend, service, or tool in this repository
(`src/**` and root frontend manifests). Like the root `AGENTS.md`, this file is
written in English for agent interoperability.

**Last reviewed**: 2026-09-13

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

### Strict Index Access

([issue #230](https://github.com/hailingu/PlotWeave/issues/230),
implemented.) Record and array index reads carry `undefined` at the type
level under `noUncheckedIndexedAccess`, enforced by an independent check
entry: `npm run typecheck:strict-index` runs
`tsc --noEmit -p tsconfig.strict-index.json`, and
`scripts/check-static.sh` invokes it alongside Prettier and ESLint so both
the local Git gate and the Sonar gate reject violations before coverage
generation.

- **Scope**: all production source under `src/` plus `vite.config.ts`.
  **Out of scope**: `*.test.ts` / `*.test.tsx` — test fixtures build arrays
  and records locally where indices are known by construction; the strictly
  mechanical widening pass there is large and low-value, while production
  reads are where dirty data and missing keys matter. Production code that
  drifts around these rules fails the gate; test files stay on the plain
  `strict` baseline of `tsconfig.json`.
- **Satisfying the check**: for values that can genuinely be missing, handle
  the missing case explicitly with the same dirty-data semantics the
  surrounding code already uses. For locally proven invariants, express them
  in the type system or control flow instead: finite-key `Record<Union, V>`
  maps (`SettingsBuckets`, `AiWriteOp`, `AiNodeFieldType`), snapshot value
  iteration (`Object.entries`) instead of key-then-index reads, and
  extracting the single hit (`const hit = xs.length === 1 ? xs[0] :
  undefined`) before use. Loop-bound-guarded index reads may use `?.` or a
  fallback with a comment stating why the branch is unreachable. Do not
  blanket-add `!` or `as` casts; the one accepted compensation is casting
  `Object.keys` of a finite-key record back to its key union (single source
  of truth for the key set), with a comment.

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
