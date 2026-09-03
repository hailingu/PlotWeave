# TypeScript Development Standard

**Applies to**: any TypeScript frontend, service, or tool in this repository
(`src/**` and root frontend manifests). Like the root `AGENTS.md`, this file is
written in English for agent interoperability.

**Last reviewed**: 2026-09-03

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
- Distinguish browser (Tauri webview) and shared modules so
  environment-specific dependencies cannot leak across runtime boundaries; the
  browser-memory persistence fallback must stay behaviorally aligned with the
  Tauri path.

## Before Writing Code

Read this file, then inspect the target package for existing component, hook,
state-management, store-client, runtime-boundary, and test patterns. Reuse
compatible capabilities instead of introducing a parallel approach, and apply
the common size and complexity review triggers.
