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
  that file: record the complete routed-command verification below in the upgrade
  PR, and do not add platform targets without a project decision.
- Verification: from `src-tauri/`, run
  `npm --prefix .. run check:size && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`.
  The npm prefix selects the repository-root size guard before Cargo checks,
  including for Rust-only changes (issue #432). Use the Node version pinned by
  `.nvmrc`; CI runs the repository-wide guard, including Rust, in its frontend job.
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
  brace groups expanded; Rust 2018 bare paths such as `use child::…` resolve
  to a direct child of the current module, then to a root module, then through
  visible alias chains and chained glob prefixes (recursively, bounded depth —
  issue #469, PR review 5379907393) and glob imports (`use <prefix>::*`
  brings the prefix module's direct child module names into scope; glob and
  alias bindings are visible only inside their declaring module, because
  inline child modules do not inherit a parent's imports — issue #469, PR
  review 5379907393; a glob exports only child modules visible at the use
  site — private or restricted (`pub(super)`/`pub(in …)`) children never
  join glob expansion, `src/module_graph/visibility.rs` — PR review
  5380401098), and only otherwise count as an external
  crate — issue #426, whose self-contained fixtures in
  `src/module_graph/issue_426_tests.rs` require bare-path parent→child edges,
  including facade re-exports and inline-module scopes, to close
  parent↔child cycles) of every production module reachable from `lib.rs`
  through non-`#[cfg(test)]` declarations (a cfg group gates as test-only
  when it *implies* `test` — bare `test` or `all(test, …)`; `any(test,
  feature = …)` stays in as production-capable), and asserts the resulting
  dependency graph is acyclic. Before building edges the guard also runs the
  collection-completeness audit (issue #469, `src/module_graph/audit.rs`):
  every expanded `use` path whose first segment names an internal module (a
  child of the current module, a root module, or a structural
  `crate`/`self`/`super` prefix) must resolve to at least one target owner —
  self-file owners count as resolved and only the self-loop edge is dropped —
  otherwise the guard fails closed, and paths whose first segment names no
  internal module are classified and counted as external crates; the real
  repository asserts the internal-miss count is zero
  (`src/module_graph/issue_469_tests.rs`), so a #426-style silent edge drop
  cannot recur unnoticed. `NAME.rs` and `NAME/mod.rs` forms are both
  supported; test-only files (`tests.rs`, `*_tests.rs`, `testutil.rs`, `conf`,
  `testhttp`) and the binary entry `main.rs` stay out of the graph by
  reachability; platform-gated modules count as a union over targets. The
  guard fails closed — a `mod` declaration without a matching file, a
  `super::` past the crate root, or a malformed `use` tree fails the test —
  and carries counterexample fixtures (an issue #146-shaped mutual dependency
  must be reported) so it proves its own detection. Registered blind spots:
  `macro_rules!` bodies are skipped wholesale, so a `use` that exists only
  inside a macro definition is not collected; glob imports resolve only the
  prefix module's *direct* children (names re-exported into the glob target
  via `pub use` are not resolved); alias chains deeper than the bounded depth
  are treated as unresolvable.
- Test-only items are skipped with balanced generic/type and parameter
  delimiters; nested commas, where-clause commas, array semicolons and generic const blocks do
  not end the item early. Expression comparisons remain distinct from type
  delimiters. Direct struct/union fields and enum variant fields start in type
  context, including tuple fields without a colon; their list boundary also
  preserves production scanning after a final test-only field or variant
  without a trailing comma. Function-pointer and named function/method
  parameters use the same direct-element type context and their own closing
  parenthesis, including qualified/nested pointers and generic declarations.
  Return types and production bodies remain visible after the list; nested
  header/parameter/body const expressions keep local expression context
  ([PR #445 review](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5365933962)).
  Direct generic parameters in fn/struct/enum/union/trait/type/impl declarations
  have their own paired closing angle. Type-parameter defaults retain type
  context through `=`, while const defaults remain value expressions and
  lifetimes have no defaults. Final parameters preserve the following fields,
  bounds, return types and body. Unrelated type arguments, where/HRTB groups
  and nested const statements do not acquire parameter context; unclosed
  declaration lists register no artificial boundary
  ([PR #445 review](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5366421069)).
  Nested const expressions retain expression
  context ([PR #445 review](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5363739640)).
  Union declarations enter type context only when followed by a valid name
  and declaration header; ordinary uses of the weak keyword retain their
  context. Closure parameters after stable expression prefixes (return,
  break/label, references, async/move, match and direct let initializers)
  and consecutive leading closures are skipped as complete groups, followed
  by expression-body scanning or an explicit return-type header. Match arms
  and if-let/while-let bodies remain part of the gated statement; an
  independent production block after it stays visible. Const-prefixed
  groups are operands, including empty groups, and never consume a pending
  control-flow body
  ([PR #445 review](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5364837705),
  [const operand repair](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5365530615)).
  Bare/prefixed closure bodies and value initializers keep scanning const and
  operator operands even without pending control flow. An initial ordinary
  block updates its existing body count before following a binary operator;
  this preserves later match/if-let/while-let bodies and production statements.
  Direct control-flow statements end after their final body before an independent
  unary statement; let/return/break value wrappers retain binary continuation.
  Else-chain helpers preserve that original statement/value ownership.
  Standalone const/block expressions without an attached postfix, explicit
  return-type closure bodies without a postfix and type elements retain their
  own ending rules
  ([PR #445 review](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5366897147)).
  Member/tuple/await and try postfixes remain attached to their block values.
  Calls and indices continue value expressions, but preserve independent grouped
  or array statements after a direct control-flow/block statement. Explicit-return
  closure postfixes restore value state before an enclosing body's later comparison;
  pending body counts remain intact. Gated blocks, including empty blocks, consume
  their attribute at the opening brace through the existing test-item path.
  Expression-position qualified paths reuse the balanced type-group parser only
  for paired `<…>` groups followed by `::`; nested commas/const groups/function
  arrows are contained without placing subsequent comparisons in type state
  ([PR #445 review](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5367627498),
  [statement ambiguity](https://doc.rust-lang.org/reference/statements.html#expression-statements),
  [qualified paths](https://doc.rust-lang.org/reference/paths.html#qualified-paths)).
  Lexical aliases are visible throughout their enclosing scope:
  expansion first selects all bindings in the deepest visible scope, then
  appends suffixes only to bindings whose complete target is a known module;
  binding targets whose first segment is itself an alias resolve through the
  alias chain recursively (bounded depth, union over same-name bindings at
  every hop). After explicit `self` / `crate` / repeated `super` prefixes,
  the next segment resolves through module-level aliases/globs in the
  designated namespace, including bindings owned by another file or a
  parent inline module (PR #479 review 5381066396); block-local imports do
  not shadow these qualified names. Glob imports contribute the prefix
  module's direct child
  module names as bare-path candidates ([Issue #469](https://github.com/hailingu/PlotWeave/issues/469),
  `src/module_graph/issue_469_tests.rs`).
  This preserves the target-platform union while excluding shadowed outer
  scopes, test-only bindings and non-module symbol tails. Original imports
  still contribute their item-owner edges, and child-module precedence
  remains intact. [Issue #424](https://github.com/hailingu/PlotWeave/issues/424) is
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

The scanner owns test-item exclusion (`scan_tokens` / `skip_test_item` /
`field_contexts` / `qualified_path_end` / `ClosureHeaders::step_after_body`);
use-edge resolution owns alias visibility (`scan_use_stmt` /
`use_targets_of`). [Issue #424](https://github.com/hailingu/PlotWeave/issues/424)
repairs two previously registered boundaries. Fixtures in
`src/module_graph/issue_424_tests.rs` and
`src/module_graph/issue_424_alias_tests.rs` and
`src/module_graph/issue_424_function_pointer_tests.rs` and
`src/module_graph/issue_424_generic_parameter_tests.rs` and
`src/module_graph/issue_424_operand_tests.rs` and
`src/module_graph/issue_424_expression_tests.rs` exercise the complete graph builder
and the owned-context parser boundary.
[Issue #446](https://github.com/hailingu/PlotWeave/issues/446) extends the same
matrix to `return`/`break` block values (`skip_closure_headers` starts their
operand in value state); `src/module_graph/issue_446_tests.rs` covers it.
[Issue #447](https://github.com/hailingu/PlotWeave/issues/447) extends it to `as`
casts after gated closure bodies, including explicit-return closures
(`ClosureHeaders::body_continues`); `src/module_graph/issue_447_tests.rs` covers it.

| State / precondition | Action / ordering | Observable outcome | Invariant | Verification |
| --- | --- | --- | --- | --- |
| Test-only generic fn / impl and type declarations, including nested bounds and where clauses | Scan item, then production use | Only the production target remains; no false cycle | Test-only item bodies never contribute production edges | `generic_test_items_do_not_create_production_cycles`, `generic_test_where_clauses_exclude_body_dependencies` |
| Test-only generic union declaration and gated union field | Balance union header and bound the field at its list close, then scan production use | Test dependencies excluded; following production edge and real cycle retained | Union test bodies never enter the production graph | `test_only_unions_do_not_create_production_cycles`, `union_test_fields_preserve_following_production_cycles` ([PR #445 review](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5364166565)) |
| `union` used as a value, path or existing item name | Scan gated expression or item, then production use | Following production edge survives | The weak keyword enters declaration context only in union declaration syntax | `union_identifiers_preserve_production_scanning`, `union_bindings_do_not_create_field_contexts` |
| Test-only generic field, type alias or grouped header | Skip nested type/parameter delimiters, resume at the next element/item | Following production edge survives | Skipping one test item does not consume adjacent production code | `generic_test_fields_resume_at_the_next_field`, `grouped_test_item_headers_are_skipped_in_full` |
| Test-only struct / enum field or final enum variant, including tuple/generic/grouped types and visibility | Apply direct-element context, skip to the list boundary, then scan the next production field/item | Test dependencies excluded; production dependencies and real cycles retained | Field delimiters cannot leak test dependencies or consume adjacent production code | `tuple_test_fields_exclude_generic_dependencies`, `last_test_fields_preserve_following_production_cycles` ([PR #445 review](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5363739640)) |
| Test-only anonymous or named function-pointer parameter, including generic/grouped types and qualified or nested pointers | Start direct parameter in type context, stop at the owned parameter-list close, then resume production scanning | Test dependency excluded; following parameter/return/item edge and real cycle retained | A gated pointer parameter cannot leak dependencies or consume adjacent production code | `test_function_pointer_parameters_do_not_create_production_cycles`, `last_test_pointer_parameters_preserve_production_types` ([PR #445 review](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5365933962)) |
| Final gated named function/method parameter, with no trailing comma and an optional generic declaration head | Bound parameter at its own closing parenthesis, then scan the body | Only production body dependencies remain; real cycle retained | Every fn parameter-list entry point preserves the following production body | `last_test_function_parameters_preserve_production_bodies` |
| Local test statement in fn parameter/return/header const expression or ordinary body | Skip the local expression and scan its next production use | Production edge and cycle retained | Parameter context never propagates into nested expression attributes | `parameter_const_attributes_preserve_expression_scanning` |
| Function parameter attribute permits production (`any(test, unix)` or platform-only) | Apply existing cfg implication before using list context | Production dependency retained | Type-element registration never strengthens cfg test exclusion | `production_capable_parameter_attributes_preserve_edges` |
| Attributed generic type parameter in fn/struct/enum/union/trait/type/impl declarations, with a bound or an allowed default, including nested types and type-level const blocks | Preserve type context through the default equals sign; stop at its own parameter comma or generic-list close | Test dependency excluded; no false cycle | Test-only generic defaults never enter the production dependency graph | `test_generic_type_defaults_do_not_create_production_cycles` ([PR #445 review](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5366421069)) |
| Final gated generic parameter followed by fields, where bounds, return types or a function/trait body | Leave the owned closing angle for the main scanner and resume production scanning | Production edge and real cycle retained | Skipping one generic parameter never consumes adjacent production code | `last_test_generic_parameters_preserve_production_scanning` |
| Gated const or lifetime generic parameter in the same declaration list | Keep const defaults in expression context; bound every parameter at the owned close | Test dependency excluded; following production edge retained | Type defaults and value defaults retain distinct scanning semantics | `test_const_and_lifetime_parameters_preserve_production_scanning` |
| Local test statement inside a production generic bound/default const expression | Skip local expression and collect subsequent production use in the same block | Production edge and real cycle retained | Generic parameter context never propagates into nested expression attributes | `generic_default_const_attributes_preserve_expression_scanning` |
| Missing closing angle, or angle groups belonging to alias RHS, impl type arguments, return types and where/HRTB bounds | Recognize only a directly owned, paired declaration list | No artificial element context is registered | Invalid or unrelated groups never create a new skip boundary | `generic_contexts_require_owned_closed_declarations`; rustc owns full malformed-source rejection |
| Generic parameter attribute permits production | Apply existing cfg implication before generic context | Production dependency retained | Generic registration never strengthens cfg test exclusion | `production_capable_generic_parameters_preserve_edges` |
| Test-only comparison statement / initializer, including typed closures and labelled loops | Scan `<` comparison, then production use | Test edges excluded, following edge retained | Expression operators do not hold type delimiters open | `test_comparisons_do_not_swallow_following_production_uses` |
| Test statement inside a field-type const block | Skip the local test expression, then collect production use in the same block | Following production edge and cycle retained | Nested expressions never inherit field type context | `test_field_const_expressions_preserve_production_uses` |
| Test-only bare / move / async closure with typed, grouped or empty parameters and optional generic return type | Skip the complete closure header and body, then collect production use | Test-only target excluded; following production cycle detected | Closure parameter colons and expression operators cannot change production scanning boundaries | `bare_test_closures_preserve_following_production_cycles` ([PR #445 review](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5363378084)) |
| Test-only typed closure after return, break/label, reference or async/move prefixes, including consecutive closure heads | Skip expression prefixes and consecutive closure parameters, then body and production use | Test target excluded; following production cycle detected | Expression prefixes cannot change closure exclusion or production scanning boundaries | `prefixed_test_closures_preserve_following_production_cycles` ([PR #445 review](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5364166565)) |
| Test-only typed closure in let initializer or match / if-let / while-let scrutinee, including value-prefix/arithmetic/comparison operand blocks, explicit return bodies and empty nested match arms | Consume closure header, body and enclosing control-flow body before resuming | Test dependencies excluded; next production edge and true cycle retained | A closure body cannot end the enclosing gated control-flow statement | `control_flow_test_closures_preserve_production_cycles`, `let_condition_test_closures_preserve_production_cycles`, `control_flow_closures_resume_at_following_blocks` ([PR #445 review](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5364837705)) |
| Bare or prefixed test closure body contains multiple const/operator operand blocks | Keep expression operands in the gated statement until its statement/list boundary | Test dependencies excluded; no false cycle | Operand groups cannot end a gated expression while another operand remains | `bare_closure_operands_do_not_create_production_cycles` ([PR #445 review](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5366897147)) |
| Expression closure starts with an ordinary block followed by a binary operator, including match/if-let/while-let nesting | Finish that block's existing body-count transition before continuing the binary expression | All gated operands excluded; enclosing body and following production edge retained | An operand continuation cannot leave a stale body count that consumes a later production block | `bare_closure_operands_do_not_create_production_cycles`, `closure_operand_statements_preserve_production_cycles` |
| Multi-operand gated closure/value initializer precedes a production use or separate block | Consume gated operands, then resume at the production statement | Production dependency and true cycle retained | Operand continuation never consumes adjacent production statements | `closure_operand_statements_preserve_production_cycles` |
| Test-only standalone const/block expression without a semicolon or attached postfix, or explicit-return closure/type element without a postfix | Apply binary-operand continuation only in an active initializer or pending control flow; keep type/list boundaries | Subsequent production block/field remains visible | Expression operand rules do not turn independent blocks or type elements into more test code | `operand_continuation_preserves_nonclosure_and_type_boundaries` |
| Gated match/if-let/while-let statement ends before an independent unary expression; match also appears inside let/return/break values | Finish the entry control-flow statement, but continue binary operands inside a value wrapper | Independent production edge and true cycle retained; wrapped test operands excluded | Finishing a statement cannot transfer its gate to the next unary statement | `completed_control_flow_preserves_unary_production_statements` |
| Gated closure or value block has member/call/index/try postfixes, including chains and explicit-return closures | Consume attached postfixes, groups and subsequent operands before the statement boundary; restore value state even while an enclosing body remains pending | Test imports excluded; no false cycle | A braced value cannot end its gate while a postfix remains | `test_postfix_expressions_exclude_operand_dependencies`, `postfix_expressions_preserve_following_production_cycles`, `explicit_return_postfixes_restore_enclosing_expression_context` ([PR #445 review](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5367627498)) |
| Direct control-flow/standalone block statement precedes a grouped/array/unary/range statement, while member/try postfixes remain attached; a gated block may be empty | `scan_tokens` consumes block attributes at the opening brace; preserve statement ambiguity rules and original statement/value ownership through postfix scanning | Independent production edges and true cycles retained; attached test operands excluded | Call/index continuation of a value cannot reclassify independent production statements | `postfix_scanning_preserves_statement_and_item_boundaries` |
| Gated `return` / `break` / labelled `break` whose operand is a block (including one returning a closure), `if`/`match` value, followed by call, index, member, `as` cast or binary continuation | Start the jump operand in value state, consume block and continuation, end at the statement boundary | Test imports excluded; no false cycle | A jump-wrapped block value cannot hand its attached continuation to production scanning | `jump_block_value_continuations_exclude_test_dependencies` ([Issue #446](https://github.com/hailingu/PlotWeave/issues/446), [PR #450 review](https://github.com/hailingu/PlotWeave/pull/450#pullrequestreview-5373620552)) |
| Gated jump expression (with or without a value) ends before an independent block/array/grouped/unary statement; direct block/control-flow statements unchanged | Finish at the `;` boundary, resume production scanning | Following production edge and true cycle retained | Value state of a jump operand never extends past its own statement | `jump_block_values_preserve_following_production_cycles` |
| Gated jump in tail position without a semicolon (block, operand, cast or call value, or bare `return`) | `skip_test_item` ends at the enclosing block's `}` without consuming it; `scan_tokens` closes that block | Following production item edge and true cycle retained | A gated item never scans past the block that encloses it | `tail_jump_values_end_at_the_enclosing_block` ([PR #450 review](https://github.com/hailingu/PlotWeave/pull/450#pullrequestreview-5373725075)) |
| Ungated or production-capable (`unix`, `any(test, unix)`) jump block value with continuation | Apply existing cfg implication before expression skipping | Production edge and true cycle retained | Jump value state never strengthens cfg test exclusion | `production_jump_block_values_preserve_edges` |
| Gated bare/move/typed/let-bound closure, or explicit-return closure, whose body is followed by an `as` cast (target type may contain a const block) and further binary operands | Continue the closure value through the cast and its operands; an explicit-return body continues only because its type header belongs to the closure | Test imports excluded; no false cycle | A cast cannot hand its target type or later operands to production scanning | `closure_cast_continuations_exclude_test_dependencies` ([Issue #447](https://github.com/hailingu/PlotWeave/issues/447)) |
| Gated closure cast or explicit-return closure ends before an independent block/array/grouped/unary statement | Finish at the `;` boundary, resume production scanning | Following production edge and true cycle retained | Cast continuation never extends past its own statement | `closure_casts_preserve_following_production_cycles` |
| Ungated or production-capable closure cast continuation | Apply existing cfg implication before expression skipping | Production edge and true cycle retained | Cast continuation never strengthens cfg test exclusion | `production_closure_casts_preserve_edges` |
| Gated initializer/discriminant/closure contains a qualified path with nested generic types, const groups or function arrows | Reuse balanced type-group parsing only for a paired `<…>` followed by `::` | Type-local test imports excluded; subsequent production edge and true cycle retained | Expression qualified paths cannot expose internal commas or change later comparison state | `test_qualified_initializers_exclude_type_dependencies`, `qualified_expressions_preserve_following_production_cycles` ([Rust qualified-path grammar](https://doc.rust-lang.org/reference/paths.html#qualified-paths)) |
| Ordinary comparison or unmatched/non-qualified angle candidate appears in a gated expression | Reject qualified-path recognition and retain ordinary expression boundaries | Following production dependency and true cycle remain visible | Recognizing a qualified type group cannot turn comparisons into generic delimiters | `qualified_path_recognition_preserves_comparison_boundaries`, `qualified_path_candidates_require_a_closed_type_group_and_separator` |
| Postfix or qualified-path attribute also permits production | Apply the existing cfg implication before expression skipping | Production operand/type imports and true cycles remain visible | Expression grammar never strengthens test-only cfg exclusion | `production_capable_expression_attributes_preserve_edges` |
| Closure attribute permits production | Apply existing cfg implication before expression continuation | Every operand dependency remains; true cycle retained | Operand classification never strengthens cfg test exclusion | `production_capable_closure_operands_preserve_edges` |
| Test-only match / if-let / while-let closure with empty or nonempty const-block body / operand | Skip the const operand, then enclosing body and following production code | Test dependencies excluded; following production edge and true cycle retained | A const operand group never consumes the enclosing control-flow body | `const_test_closure_bodies_do_not_create_production_cycles`, `const_test_closures_preserve_following_production_blocks` ([PR #445 review](https://github.com/hailingu/PlotWeave/pull/445#pullrequestreview-5365530615)) |
| Same-scope function and module aliases share a spelling, in either declaration order | Select deepest lexical bindings, then append a qualified suffix only to exact module targets | Real item-owner and module-child edges remain; no invented function-owner child or false cycle | Non-module symbol tails never become module prefixes for qualified alias expansion | `namespace_disjoint_aliases_exclude_false_child_edges`, `namespace_disjoint_aliases_preserve_module_cycles`; `relative_namespace_aliases_resolve_exact_modules` |
| Same-scope platform aliases share a name | Reference before declarations; reverse their order | Both platform child edges and cycles detected | Every equally deep visible module binding contributes to the target union | `platform_alias_union_is_independent_of_declaration_order` |
| Inner non-module type alias shadows an outer module alias | Select deepest lexical bindings before checking exact module eligibility | Outer module child stays excluded; original item-owner edge remains | Eligibility filtering cannot restore an outer binding shadowed by a deeper scope | `inner_type_aliases_do_not_restore_outer_module_candidates` |
| Nested platform aliases shadow outer aliases | Resolve inner reference before inner declarations | Both inner targets; no outer child targets | Only the deepest visible scope contributes alias expansion | `inner_alias_union_shadows_all_outer_candidates`; existing sibling-scope and child-precedence fixtures |
| One platform alias implies test | Collect aliases then resolve production reference | Only production-capable target remains | Test-only bindings never contaminate the platform union | `test_only_platform_aliases_do_not_join_production_union` |
| Module-level alias qualified by `self` in a chained import | Consume the prefix, resolve its next segment through the specified namespace, then append the suffix | Deep module edge and real cycle retained | Explicit prefixes cannot bypass alias resolution | `qualified_self_aliases_preserve_cycles` |
| Root/parent alias owned by another file, or parent inline module | Resolve `crate` / repeated `super` at the target module's declaration scope | Target file edge and real cycle retained | Qualified lookup uses the designated module's bindings, not the importing file's bindings | `qualified_root_and_parent_aliases_preserve_cycles`, `qualified_parent_inline_aliases_use_the_declaring_namespace` |
| Glob-introduced module name follows `self` / `crate` / `super` | Resolve the qualified glob prefix, then expand the later use | Deep target edge and real cycle retained | Position prefixes do not break visible glob chains | `qualified_glob_prefixes_preserve_cycles` |
| Local block alias shadows a module-level alias with the same name | Compare qualified module lookup with lexical block lookup | Qualified edge uses the module alias; no false block-target edge | Explicit namespace qualification ignores block-local bindings | `qualified_self_ignores_block_alias_shadowing` |
| Same-name platform aliases / external alias after a position prefix | Preserve target union and exact-module qualification | Both internal targets retained; no invented external child edge | Qualification does not narrow the platform union or turn external symbols into internal modules | `qualified_aliases_keep_platform_union_and_external_boundaries` |

The scan is synchronous and stateless per fixture; retries, persistence and
completion races are not applicable. Existing fail-closed malformed-use and
missing-module fixtures retain failure coverage. Macro-body imports,
non-ASCII identifiers, glob imports that reach names re-exported into the
glob target via `pub use` (only the prefix module's direct children
resolve), and alias chains beyond the bounded recursion depth remain outside
this text scanner's supported boundary; this repair adds no parser dependency.
[Issue #469](https://github.com/hailingu/PlotWeave/issues/469) extends the
same matrix to collection completeness: glob-introduced module names and
chained aliases must form edges (closing sibling/deep-module cycles), chains
through external crates stay external, and the audit layer fails closed when
a first segment that names an internal module yields zero target owners —
with the real repository asserting a zero internal-miss count plus a sampled
bare-path facade edge. Its review round
([PR #479 review 5379907393](https://github.com/hailingu/PlotWeave/pull/479#pullrequestreview-5379907393))
adds two rows: chained glob prefixes (`use crate::p::*; use a::*;`) resolve
through earlier visible globs so the deep target forms its edge, and
glob/alias bindings are visible only inside their declaring module — a bare
name in an inline child module that collides with the parent's glob/alias
target stays external instead of fabricating an internal edge and a false
cycle. A second round
([PR #479 review 5380401098](https://github.com/hailingu/PlotWeave/pull/479#pullrequestreview-5380401098))
adds visibility fidelity: glob expansion accepts only child modules visible
at the use site — private and restricted (`pub(super)`/`pub(in …)`)
children are recorded as visibility subtrees at tree build and never join
glob expansion outside their subtree, so a bare name that collides with a
private child of the glob target resolves externally instead of fabricating
an internal edge and a false cycle; inside the declaring subtree the glob
still imports them. A third round
([PR #479 review 5380788578](https://github.com/hailingu/PlotWeave/pull/479#pullrequestreview-5380788578))
resolves leading `super` segments in `pub(in super…)` by walking up the
declaring module, and lets any public variant among cfg-exclusive
declarations of the same child permanently widen the merged visibility
regardless of declaration order. A fourth round
([PR #479 review 5381066396](https://github.com/hailingu/PlotWeave/pull/479#pullrequestreview-5381066396))
resolves aliases and visible globs after explicit position prefixes. The
scanner records whether each binding belongs to its module namespace;
qualified lookup selects the designated module's canonical file owners
(platform union) and inline stack before applying the existing bounded
chain resolver. This preserves real deep-module cycles without letting
block-local imports fabricate qualified edges. Six regression tests first
failed for missing target edges, then passed; seven disposable rustc
fixtures confirmed the representative import shapes are legal Rust 2021.
The new matrix rows above cover prefix, namespace, glob, shadowing, platform
and external-boundary transitions. No persistent state or asynchronous
transition is introduced. The existing deepest-lexical-scope rule does not
implement full Rust namespace lookup across scopes: an inner function alias
can still prevent expansion through an outer module alias. Exact-module
qualification leaves that pre-existing resolution gap unchanged; expanding
namespace modeling is separate work, not a risk-acceptance disposition in
this repair.

Verification for this revision: all 114 module-graph tests pass; the Rust
Scope Routing command passes (`check:size`, `cargo fmt --check`, Clippy
with warnings denied, and all 628 library tests plus integration targets).
The documentation review checked matrix coverage, retained boundaries and
links against the implementation; no automated prose check is configured.
Decomposition review keeps binding records in their owning alias module,
reducing `module_graph.rs` from 789 to 776 lines. `aliases.rs` is 383 lines
and the new regression module is 146 lines. The 65-line `expand_segments`
remains one candidate-priority operation; qualified namespace resolution
is delegated, while splitting its remaining branches would scatter the
original-path, child-module, alias and glob precedence. Changed executable
units stay below 80 code lines and within four nesting levels.

## Before Writing Code

Read this file, then inspect the target crate for existing state/config
patterns, command handlers, error types, and test fixtures. Reuse or extend
what already exists before adding new abstractions, preserve the intended
crate dependency direction, and apply the common size and complexity review
triggers.
