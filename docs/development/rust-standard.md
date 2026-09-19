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

## Test Coverage

Rust coverage is measured and imported into the quality report
([issue #169](https://github.com/hailingu/PlotWeave/issues/169)):
`scripts/rust-coverage.sh` runs `cargo-llvm-cov llvm-cov --lib
--test media_format_leaf --lcov --manifest-path src-tauri/Cargo.toml` and
validates the report (non-empty,
has source records, has covered lines), and the quality gate regenerates it
before every analysis so the report distinguishes measured-uncovered lines
from unmeasured files. Metric and scope:

- **口径**：LLVM source-based **line (statement) coverage**, exported as
  LCOV (`DA`/`LF`/`LH` per file) for the product library `src-tauri/src`
  exercised by the library test suite (`--lib`) **plus the
  `media_format_leaf` integration target** (`--test media_format_leaf`,
  the issue #146 module-boundary regression; PR #223 review — omitting it
  left its executed paths invisible to the report).
- **分支口径的记录边界**：LLVM branch coverage (`--branch` → LCOV `BRDA`)
  requires the nightly-only `-Z coverage-options=branch` flag; the
  repository pins the stable toolchain (issue #167), so branch coverage is
  not measured. Introducing a nightly coverage toolchain is a project
  decision.
- **排除范围**：no source file is excluded. `#[cfg(test)]` inline test
  modules are measured as part of their host files (their lines execute
  under the test suite). The `native_quit` integration fixture is excluded
  (macOS-specific AppKit child-process scenario — platform-specific and
  process-spawning, kept out of the coverage report deliberately). The
  frontend is outside this report (the frontend has its own LCOV
  import).
- **基线（2026-09-19，含 media_format_leaf）**：5619/6803 lines = 82.6%
  line coverage over 41 source files, established with
  `cargo-llvm-cov 0.9.0` on the pinned stable toolchain. Coverage thresholds/conditions on the Quality Gate are
  a separate project decision and are intentionally not configured by the
  introduction change.
- **工具链**：`llvm-tools` is pinned in `rust-toolchain.toml` (provides
  `llvm-profdata`/`llvm-cov`); developers additionally need
  `cargo install cargo-llvm-cov`.

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
