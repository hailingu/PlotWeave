# Rust Development Standard

**Applies to**: any Rust crate in this repository (`src-tauri/**`). Like the
root `AGENTS.md`, this file is written in English for agent interoperability.

**Last reviewed**: 2026-09-30

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

## Module Boundary Guards

- `cargo test` enforces the file-granularity module-graph acyclicity guard
  (`src/module_graph.rs`, `#[cfg(test)]`-gated, issue #399): it text-scans the
  `mod` declarations and `use` paths (`crate::`/`super::`/`self::` prefixes,
  brace groups expanded) of every production module reachable from `lib.rs`
  through non-`#[cfg(test)]` declarations (a cfg group gates as test-only
  when it *implies* `test` — bare `test` or `all(test, …)`; `any(test,
  feature = …)` stays in as production-capable), and asserts the resulting
  dependency graph is acyclic. `NAME.rs` and `NAME/mod.rs` forms are both
  supported; test-only files (`tests.rs`, `*_tests.rs`, `testutil.rs`, `conf`,
  `testhttp`) and the binary entry `main.rs` stay out of the graph by
  reachability; platform-gated modules count as a union over targets. The
  guard fails closed — a `mod` declaration without a matching file, a
  `super::` past the crate root, or a malformed `use` tree fails the test —
  and carries counterexample fixtures (an issue #146-shaped mutual dependency
  must be reported) so it proves its own detection. One registered blind
  spot: `macro_rules!` bodies are skipped wholesale, so a `use` that exists
  only inside a macro definition is not collected.
- Test-only items are skipped with balanced generic/type and parameter
  delimiters; nested commas, array semicolons and generic const blocks do
  not end the item early. Expression comparisons remain distinct from type
  delimiters. Lexical aliases are visible throughout their enclosing scope:
  expansion includes all bindings in the deepest visible scope, preserving
  the target-platform union while excluding shadowed outer scopes and
  test-only bindings. Original paths and child-module precedence remain
  intact. [Issue #424](https://github.com/hailingu/PlotWeave/issues/424) is
  covered by the matrix and graph-builder fixtures below.
- This is the Rust counterpart of the frontend guard
  (`src/moduleGraph.test.ts`, issue #106); together they form the
  cross-language acyclic invariant, and `media_format_leaf.rs` (issue #146)
  additionally pins the media-format leaf boundary. Cyclic `use` edges between
  modules are a defect: resolve them by ownership clarification, contract
  extraction, or moving shared policy to a leaf owner — the issue #399 guard's
  first finding (the `library_journal` strongly-connected cluster) was
  resolved exactly that way: `fsync_dir` moved to the `library_journal/fsync.rs`
  leaf, `journal_entry_value` moved to its shape owner `journal_io`, and
  sibling modules import each other directly instead of through the parent's
  re-export hub.

### Issue #424 State And Invariant Matrix

The scanner owns test-item exclusion (`scan_tokens` / `skip_test_item`);
use-edge resolution owns alias visibility (`scan_use_stmt` /
`use_targets_of`). [Issue #424](https://github.com/hailingu/PlotWeave/issues/424)
repairs two previously registered boundaries. Fixtures in
`src/module_graph/issue_424_tests.rs` exercise the complete graph builder.

| State / precondition | Action / ordering | Observable outcome | Invariant | Verification |
| --- | --- | --- | --- | --- |
| Test-only generic fn / impl, including nested bounds | Scan item, then production use | Only the production target remains; no false cycle | Test-only item bodies never contribute production edges | `generic_test_items_do_not_create_production_cycles` |
| Test-only generic field, type alias or grouped header | Skip nested type/parameter delimiters, resume at the next element/item | Following production edge survives | Skipping one test item does not consume adjacent production code | `generic_test_fields_resume_at_the_next_field`, `grouped_test_item_headers_are_skipped_in_full` |
| Test-only comparison statement / initializer, including typed closures and labelled loops | Scan `<` comparison, then production use | Test edges excluded, following edge retained | Expression operators do not hold type delimiters open | `test_comparisons_do_not_swallow_following_production_uses` |
| Same-scope platform aliases share a name | Reference before declarations; reverse their order | Both platform child edges and cycles detected | Every equally deep visible binding contributes to the target union | `platform_alias_union_is_independent_of_declaration_order` |
| Nested platform aliases shadow outer aliases | Resolve inner reference before inner declarations | Both inner targets; no outer child targets | Only the deepest visible scope contributes alias expansion | `inner_alias_union_shadows_all_outer_candidates`; existing sibling-scope and child-precedence fixtures |
| One platform alias implies test | Collect aliases then resolve production reference | Only production-capable target remains | Test-only bindings never contaminate the platform union | `test_only_platform_aliases_do_not_join_production_union` |

The scan is synchronous and stateless per fixture; retries, persistence and
completion races are not applicable. Existing fail-closed malformed-use and
missing-module fixtures retain failure coverage. Macro-body imports,
non-ASCII identifiers and recursive alias-chain inference remain outside this
text scanner's supported boundary; this repair adds no parser dependency.

## Before Writing Code

Read this file, then inspect the target crate for existing state/config
patterns, command handlers, error types, and test fixtures. Reuse or extend
what already exists before adding new abstractions, preserve the intended
crate dependency direction, and apply the common size and complexity review
triggers.
