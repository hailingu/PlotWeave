# Rust Development Standard

**Applies to**: any Rust crate in this repository (`src-tauri/**`). Like the
root `AGENTS.md`, this file is written in English for agent interoperability.

**Last reviewed**: 2026-09-03

## Required Reading

- [Software Engineering Standard](software-engineering-standard.md) — the
  repository-wide baseline for size, module boundaries, dependency direction,
  abstractions, patterns, testing, and exceptions.
- The Rust Style Guide — the canonical formatting reference; defer to `rustfmt`
  (which implements it) for mechanical formatting instead of hand-formatting or
  debating style.
- Rust API Guidelines — naming, interoperability, documentation, and
  predictability guidance for public crate APIs.

## Baseline Practices

- Toolchain: the repository pins `rustc`/`rustfmt`/`clippy` via
  `rust-toolchain.toml` at the repository root (currently `1.95.0`; issue
  #167). rustup resolves it from any repository directory, so routed checks
  are reproducible on a clean machine. Upgrades are a dedicated change to
  that file: record the routed-command verification (`cargo fmt --check &&
  cargo clippy --all-targets -- -D warnings && cargo test`) in the upgrade
  PR, and do not add platform targets without a project decision.
- Format with `cargo fmt`; do not hand-format around it.
- Lint with `cargo clippy`; treat new warnings as defects to fix or explicitly
  and narrowly suppress with a comment explaining why.
- Prefer `Result<T, E>` and domain error types for fallible behavior; avoid
  `unwrap()`/`expect()` in production paths unless the invariant is local,
  explicit, and documented.

## Rust Engineering Practices

- Give each crate one coherent capability and keep its public surface narrow.
  Split crates for ownership, compilation, reuse, or dependency boundaries, not
  merely to reduce file size.
- Organize modules by domain or feature (for example the `isotime` extraction
  from `store`). Keep `lib.rs` and `mod.rs` focused on declarations and
  intentional re-exports rather than orchestration or hidden initialization.
- Define traits at the consuming boundary when multiple implementations,
  external I/O, or test substitution requires them. Do not introduce a trait
  only to mirror every inherent implementation.
- Keep transport, serialization, persistence, and provider types in adapters.
  Model validated domain identifiers and invariants with enums and newtypes
  instead of passing primitive strings through the core.
- File-system trust boundaries follow the root `AGENTS.md` and the anchored
  handle semantics established in the `store` persistence modules
  (`store/persist.rs`; `projects_dir` capability
  handles, no-follow classification, identity binding): new persistence paths
  MUST NOT regress to name-based re-resolution.
- Prefer explicit ownership and message passing over shared mutable state.
  When shared state is necessary, document lock ownership, ordering,
  contention, cancellation, and poison or failure behavior.
- Lock poisoning follows one domain policy (issue #145): default to
  **verifiable recovery** through the shared `crate::lock::recover_guard`
  kernel — never propagate the panic and never silently ignore it. Recovery
  is permitted only with a documented per-lock justification recorded at the
  lock site: on-disk consistency is owned by an independent protocol (the
  §7.2 journal recoverable-commit protocol, the §10.2 atomic-write
  protocol), or the guarded state is advisory in-memory data whose
  individual operations are infallible (registries, cancel flags, the
  counting gate). Choosing an explicit error or controlled termination
  instead requires a documented rationale at the lock site; silently
  ignoring a poisoned lock while reporting success is prohibited.
- Error enums belong to the layer that can interpret the failure. Preserve
  sources when adding context and avoid a single unstructured error variant for
  unrelated failure classes.

## Before Writing Code

Read this file, then inspect the target crate for existing state/config
patterns, command handlers, error types, and test fixtures. Reuse or extend
what already exists before adding new abstractions, preserve the intended
crate dependency direction, and apply the common size and complexity review
triggers.
