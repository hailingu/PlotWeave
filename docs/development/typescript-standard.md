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
- Use named exports only (per the Google TypeScript Style Guide reference
  above; [issue #164](https://github.com/hailingu/PlotWeave/issues/164),
  implemented). `React.lazy` assembly is not a reason to keep a default
  export: map the named export at the assembly point, e.g.
  `lazy(() => import('./EditorView').then((m) => ({ default: m.EditorView })))`.
- Distinguish browser (Tauri webview) and shared modules so
  environment-specific dependencies cannot leak across runtime boundaries; the
  browser-memory persistence fallback must stay behaviorally aligned with the
  Tauri path.

## Before Writing Code

Read this file, then inspect the target package for existing component, hook,
state-management, store-client, runtime-boundary, and test patterns. Reuse
compatible capabilities instead of introducing a parallel approach, and apply
the common size and complexity review triggers.
