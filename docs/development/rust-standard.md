# Rust Development Standard

**Applies to**: any Rust crate in this repository (`src-tauri/**` and `crates/**`). Like the
root `AGENTS.md`, this file is written in English for agent interoperability.

**Last reviewed**: 2026-10-13

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
  that file: record the complete routed-command verification below in the upgrade
  PR, and do not add platform targets without a project decision.
- Verification: from `src-tauri/`, run
  `npm --prefix .. run check:size && npm --prefix .. run check:workspace-drift && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`.
  From `crates/`, run the same command for the independent kernel/FFI workspace.
  The npm prefix selects the repository-root size guard and the dual-workspace
  dependency drift guard (`check:workspace-drift`, issue #549) before Cargo
  checks, including for Rust-only changes (issue #432). Use the Node version pinned by
  `.nvmrc`; CI runs the repository-wide guard, including Rust, in its frontend job.
- Format with `cargo fmt`; do not hand-format around it.
- Lint with `cargo clippy`; treat new warnings as defects to fix or explicitly
  and narrowly suppress with a comment explaining why.
- Prefer `Result<T, E>` and domain error types for fallible behavior; avoid
  `unwrap()`/`expect()` in production paths unless the invariant is local,
  explicit, and documented.

## Crate Layout

- `src-tauri/` — the Tauri host application: command wrappers, host-specific
  adapters (data-root resolution via `AppHandle`), and domains not yet
  extracted. Persistence and other kernels must not depend on `AppHandle`.
- `crates/plotweave-core/` — host-agnostic business kernels extracted from
  `src-tauri` (project storage first, P2 of the native-shell migration): data
  roots are injected by the caller, no Tauri runtime dependency, kernels stay
  callable from both the Tauri adapter and the FFI boundary.
- `crates/plotweave-ffi/` — the historical P2 C ABI boundary for the Swift host: opaque
  handle, JSON request/response, worker-thread completion callbacks, explicit
  allocation/free and cancellation contracts (see the crate-level docs of
  `plotweave-ffi/src/lib.rs`).
  The current native application uses Swift services and does not link this
  crate; Tauri/core and ABI regressions remain in the Rust gate's scope.
- `crates/` forms its own Cargo workspace; run its routed checks from the
  `crates` directory. The two workspaces resolve `plotweave-core`
  independently, so shared dependency versions can drift silently; the
  guard `npm run check:workspace-drift` (issue #549) compares the kernel's
  resolved closure between both locks (`cargo tree --locked`, never
  rewriting them) and runs in the Rust CI job — align drift with
  `cargo update` instead of bypassing it.
- Core fault-injection helpers are available through `cfg(test)` or the
  `test-support` feature. The Tauri host enables that feature only in its
  dev-dependency for cross-domain integration regressions; the production
  dependency does not enable it.

## Test Coverage

Rust coverage is measured and imported into the quality report
([issue #169](https://github.com/hailingu/PlotWeave/issues/169)):
`scripts/rust-coverage.sh` runs `cargo-llvm-cov llvm-cov --lib
--test media_format_leaf --lcov --manifest-path src-tauri/Cargo.toml` plus
`cargo-llvm-cov llvm-cov --workspace --lib --test abi --lcov
--manifest-path crates/Cargo.toml` — each invocation additionally carries
`--jobs <budget>` and executes with `RUST_TEST_THREADS=<budget>`, bounding
compile and test-execution parallelism per the gate CPU budget (owner
decision 2026-10-16, see
[Gate CPU Budget](quality-gate-cost.md#gate-cpu-budget-2026-10-16-owner-direction)).
It validates each report (non-empty,
source records and covered lines), then merges them into
`src-tauri/target/coverage/lcov-rust.info`. Identical source-path/line records
are counted once, with hits combined across both workspaces. The quality
gate regenerates this report before every analysis so extracted core and
FFI source cannot silently leave the measured scope. For historical pushed
trees checked by the current gate (issue #405), the script follows that
tree's manifests: a tree predating `crates/Cargo.toml` generates only the
Tauri report; when the crates manifest exists, both workspace reports are
mandatory. Metric and scope:

- **口径**：LLVM source-based **line (statement) coverage**, exported as
  LCOV (`DA`/`LF`/`LH` per file) for `src-tauri/src`,
  `crates/plotweave-core/src` and `crates/plotweave-ffi/src`. The Tauri
  library suite (`--lib`) runs **plus the
  `media_format_leaf` integration target** (`--test media_format_leaf`,
  the issue #146 module-boundary regression; PR #223 review — omitting it
  left its executed paths invisible to the report). The independent crates
  workspace runs its library suites and the FFI `abi` integration target.
  SonarQube lists all three maintained Rust source roots and both Cargo
  manifests; the uniform 80% floor applies to the merged report.
- **分支口径的记录边界**：LLVM branch coverage (`--branch` → LCOV `BRDA`)
  requires the nightly-only `-Z coverage-options=branch` flag; the
  repository pins the stable toolchain (issue #167), so branch coverage is
  not measured. Introducing a nightly coverage toolchain is a project
  decision.
- **排除范围**：no product source file is excluded. Standalone modules
  enabled only for `cfg(test)` / `test-support` are classified as Sonar
  test inputs rather than product source; inline test modules retain the
  existing coverage measurement below. `#[cfg(test)]` inline test
  modules are measured as part of their host files (their lines execute
  under the test suite). The `native_quit` integration fixture is excluded
  (macOS-specific AppKit child-process scenario — platform-specific and
  process-spawning, kept out of the coverage report deliberately). The
  frontend is outside this report (the frontend has its own LCOV
  import).
- **基线（2026-09-19，含 media_format_leaf）**：5619/6803 lines = 82.6%
  line coverage over 41 source files, established with
  `cargo-llvm-cov 0.9.0` on the pinned stable toolchain.
- **下限（issue #393）**：overall line coverage has a versioned, failable
  floor of **80%**, deliberately matched to the local SonarQube server's
  Quality Gate coverage condition rather than the 82.6% baseline — the gap
  is headroom, not a commitment to maintain the baseline (per-run values:
  `docs/development/gate-history.jsonl`, `rustLineCoveragePercent`).
  `scripts/sonar-quality-gate.sh` checks the Rust LCOV — and the frontend
  LCOV — against this floor on the same `DA` line-hit basis before every
  analysis; the frontend additionally enforces it through vitest
  `coverage.thresholds` in `vite.config.ts` (see
  [typescript-standard.md](typescript-standard.md) "Coverage Floor And
  Baseline" for the frontend floor and baseline). Exactly 80% passes — the
  comparison uses unrounded hit counts, so a true ratio that merely rounds
  to a displayed 80.00% is still rejected (rounded percentages are display-
  and ledger-only).
  Compliance must not be reached by widening any exclusion list
  (`scripts/sonar-test-scope.test.ts` guards the frontend list
  bidirectionally; this Rust report excludes no source file). This
  supersedes the introduction change's "thresholds intentionally not
  configured" position.
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
  kernel — never propagate the panic and never silently ignore it. The
  kernel has one repository-wide source (issue #549): `plotweave-core`'s
  `pub mod lock`; `src-tauri` re-exports it as `crate::lock` and
  `plotweave-ffi` delegates to it, so duplicate copies of the same policy
  are prohibited. Recovery
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

## Shared Test Fixtures (issue #504)

The test-only `crate::library_fixture` owns raw library index/journal writes,
asset record fields, temporary library/project roots, capability handles and
real file identities for library, journal, normalization and media tests.
Domain wrappers retain their explicit defaults and corrupt byte inputs; the
fixture does not call production normalization. The parser-based
declaration-ownership guard (`module_graph/fixture_ownership_tests.rs`) and
the shared graph-topology fixture (`module_graph/dependency_fixture.rs`) that
lived inside the retired module-graph subsystem were deleted with it
([issue #524](https://github.com/hailingu/PlotWeave/issues/524)): duplicate
declarations of the shared fixture capabilities are again detected only by
CPD and review, and download rejection tests keep sharing the real-client
result assertion while retaining each raw response and expected request
count. No test classification or exclusion changes accompany this
retirement. Measurements, the state/invariant matrix and retained boundaries
of the original extractions are recorded in
[duplication policy](duplication-policy.md#rust-测试重复度续修issue-504) and
[issue #504](https://github.com/hailingu/PlotWeave/issues/504).

## Module Boundary Guards

The Rust-side file-granularity module-graph acyclicity guard
(`src-tauri/src/module_graph.rs` + `src-tauri/src/module_graph/`, issue #399)
**has been retired by owner decision**
([issue #524](https://github.com/hailingu/PlotWeave/issues/524), 2026-10-13):
the same guard logic is kept exactly once, as the frontend
`src/moduleGraph.test.ts` (issue #106), which builds its graph from the real
TypeScript AST instead of a hand-written parser. At retirement the Rust
subsystem was 31 files / 7,299 lines — a hand-written partial Rust parser
(test-only) whose maintenance had accumulated eleven issues (#399, #424,
#426, #446, #447, #453, #469, #470, #480, #494, #495), plus the meta-guard
machinery of issues #471/#495 (`scripts/check-rust-module-graph-guard.sh`,
the versioned `scripts/rust-module-graph-guard-baseline.json`, its behavior
test, the serial gate step in `scripts/sonar-quality-gate.sh`, and the CI
rust-job step). All of these were removed in the same change; the guard's
detailed capability documentation and per-issue matrices are preserved in Git
history up to the retiring commit.

Guarantee disposition after retirement:

- **Dropped**: the Rust tree's file-granularity module-graph acyclicity
  invariant is no longer machine-checked. Module-level `use` cycles are legal
  Rust and rustc does not reject them; they remain prohibited by
  [Dependency Design](software-engineering-standard.md#dependency-design) and
  are caught by review. The one cycle the guard ever found (the
  `library_journal` strongly-connected cluster, its first finding) was
  resolved structurally — `fsync_dir` moved to the `library_journal/fsync.rs`
  leaf, `journal_entry_value` moved to its shape owner `journal_io`, and
  siblings import each other directly instead of through the parent's
  re-export hub — and that structure remains in place.
- **Retained**: the `media_format_leaf` leaf-boundary regression
  (`src-tauri/tests/media_format_leaf.rs`, issue #146) still pins the
  media-format leaf boundary; the frontend
  [`src/moduleGraph.test.ts`](../../src/moduleGraph.test.ts) remains the
  single module-graph guard instance (acyclicity, model-layer purity, and
  shell→feature direction for `src/**`).
- **Governance**: reintroducing a Rust-side module-graph guard requires a new
  owner decision; a proposal must weigh the parser-maintenance record above
  and prefer existing tooling over hand-written Rust parsing.

## Before Writing Code

Read this file, then inspect the target crate for existing state/config
patterns, command handlers, error types, and test fixtures. Reuse or extend
what already exists before adding new abstractions, preserve the intended
crate dependency direction, and apply the common size and complexity review
triggers.

## Diagnostics

Production Rust diagnostics use the `log` facade, with qualified targets such as
`plotweave::store`, `plotweave::library`, `plotweave::prefs`, `plotweave::media`,
`plotweave::lock`, `plotweave::blocking`, and `plotweave::native_quit` (issue #633).
The Tauri setup installs the stderr sink once and preserves a logger already
installed by an embedding caller. The host-agnostic core and historical FFI only
emit facade records; their embedding executable owns sink initialization, as
specified by the [log library contract](https://docs.rs/log/0.4.33/log/#in-libraries).

The sink writes one JSON object per line with `level`, `target`, and `message`
fields. Keep diagnostic codes and message bodies stable while selecting an
appropriate severity: failures at `warn` or `error`, routine cleanup at `debug`.
`RUST_LOG` controls levels and targets; the default is `warn`, and
`RUST_LOG=warn,plotweave::store=debug` enables store debugging. Logging arguments
must have no business side effects because filtered records are not evaluated.
Invalid filters fall back to `warn` and emit `code=invalid-log-filter` without
printing the supplied filter text. Validate before invoking the compatibility
parser so malformed configuration cannot panic on a broken stderr pipe.
Sink write failures are best-effort and do not panic. The native quit C callback
also contains a caller-installed logger's panic, including a panic payload whose
Drop could panic, while retaining its conservative termination decision.
