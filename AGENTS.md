# PlotWeave Agent Guide

Language: Chinese (中文) is the expected language for project documentation such as `README.md` and future docs under `docs/`; this guide and the engineering standards under `docs/development/` are written in English for agent interoperability.

PlotWeave is a canvas-based short-drama production tool: creators organize scripts (剧本), scenes, characters, and branching storylines as an editable node graph, comparable to LibTV. The frontend uses Tauri with React Flow; the backend is Rust.

This guide applies to the repository root and every descendant path unless a closer `AGENTS.md` adds stricter path-specific rules. External system, developer, and user instructions retain their normal precedence. Security or contract documents remain authoritative for their decisions; this guide governs day-to-day repository work. When rules conflict or authority is unclear, stop before mutation and ask the repository owner.

`MUST` and `MUST NOT` are mandatory. `SHOULD` identifies the expected default and requires a stated reason to deviate. `MAY` is optional. Examples are informative and never override a rule.

## Non-Negotiable Gates

### Core Rules

- Preserve user and other-task changes. Do not overwrite, reformat, stage, or clean unrelated work.
- Never hard-code, expose, or log secrets, tokens, passwords, private keys, or sensitive user data.
- Use the narrowest change that satisfies the approved scope. Do not add dependencies, change contracts, or refactor adjacent code without explicit scope.
- Inspect the affected code, applicable standards, and existing internal capability before implementation. Reuse a suitable component, client, helper, schema, or script.
- New public files, modules, classes, components, hooks, types, functions, and methods MUST receive intent-bearing documentation before their implementation bodies.
- Use explicit error handling and structured diagnostics supported by the project; do not conceal failures.
- Do not hard-code environment-specific values or modify generated or vendored content unless the configured workflow explicitly requires it.
- Run non-interactive checks for every affected path and report commands, results, and anything not run.
- Keep each maintained source-code file at or below **800 physical lines** (`wc -l`) and each test file at or below **1800 physical lines**. This applies to `src/**`, `src-tauri/**`, and `scripts/**`; test files are those matching `**/*.test.{ts,tsx}`, and a Rust file with an inline `#[cfg(test)]` module counts as a source file. Files that already exceed a cap when this rule lands are grandfathered at their current line count: they MUST NOT grow past it, and the next substantive change to them SHOULD split or extract modules until they comply. New files MUST comply from creation.
- File caps are automatically enforced by `npm run check:size`, `scripts/check-static.sh`, and CI (issue #432, option B). [File Size Guard](docs/development/file-size-guard.md) defines maintained-source discovery, the bounded grandfather baseline, and diagnostic contracts. The executable-unit cap below is a non-mandatory, review-enforced standard with no dedicated detection tool (issue #468 owner decision, 2026-10-02); no function/closure exemption is introduced.
- Each function, method, hook, component, or Rust `fn` SHOULD stay at or below **80 code lines**, counted from its signature line through its closing brace. Comment lines — documentation or inline, anywhere in the span — do not count toward the cap (owner decision, 2026-09-16); blank lines still count. This applies to the same trees as the file-size caps and covers test helpers and fixture builders alike. The cap is deliberately non-mandatory (issue #468 owner decision, 2026-10-02): no automated check measures it and no dedicated detection tool will be created for it — code review is its sole enforcement point. When review identifies an executable unit above the cap in code the reviewed change introduces or materially changes, the finding MUST be fixed in that change by splitting the unit (extracting helpers, subcomponents, or fixtures); it cannot be discharged by a record-only disposition or an engineering-exception entry. New units SHOULD comply from creation. The pre-existing stock of over-limit units is not bulk-migrated: a substantive change that touches an over-limit unit SHOULD bring it within the cap, and a review that observes an unrelated pre-existing over-limit unit records it as debt — a tracked issue or the pull request's recorded-debt note — instead of forcing an out-of-scope refactor.
- Keep the versioned `pre-commit`, `pre-merge-commit`, `prepare-commit-msg`, and `pre-push` hooks enabled. Before any commit, merge commit, revert, cherry-pick, rebase replay, or push, run the shared static checks (`scripts/check-static.sh`: Prettier format check + ESLint with zero warnings + `npm run check:size` + `npm run typecheck:strict`), generate fresh frontend and Rust coverage and enforce the versioned 80% overall line-coverage floor on both reports (issue #393; vitest `thresholds` in `vite.config.ts` plus the LCOV re-check in `scripts/sonar-quality-gate.sh`), run SonarQube, wait for the Quality Gate, and require zero unresolved issues on new code (incremental zeroing via the New Code period; historical overall-code issues are triaged separately and do not block Git operations). A failed or unavailable gate blocks the Git operation. The commit-creating hooks share `scripts/gate-tree-marker.sh` (issues #404/#429): `pre-commit` and `pre-merge-commit` record the gated index tree and the calling Git process identity (PID + start time) after a passing run, and the marker is single-use — consumed only by the same process's `prepare-commit-msg`, never written by a fallback gate run; an aborted operation's residue cannot match a later Git process, and an unavailable identity requires the full gate — so a covered commit-creating operation runs the complete gate exactly once. Automatic commits without a `pre-commit`-equivalent hook (`git merge --no-ff`, `git revert`, `git cherry-pick`, rebase replays) are gated through `pre-merge-commit` / `prepare-commit-msg`, and commit-side `--no-verify` cannot skip the local gate because `prepare-commit-msg` still fires and finds no reusable marker (issue #429 binds reuse to the current Git process so aborted operations cannot authorize later commits). `pre-push` consumes the pushed refs Git hands it on stdin and gates every pushed ref at that ref's commit state (issue #405): when a pushed commit is `HEAD` and both the index and the working tree are provably identical to it (no tracked differences, and no untracked non-ignored files anywhere in the repository), the complete gate runs for it in the current working tree; every other commit — a non-checked-out ref, a dirty worktree, or an additional distinct commit in a multi-ref push — is checked out into a temporary worktree whose dependencies are installed from that tree's lockfiles (`npm ci`) and gated there through the current gate scripts (`PLOTWEAVE_GATE_REPOSITORY_ROOT`), and that slow path never touches the user's working tree. The fast/slow choice is made per unique pushed commit and does not depend on what else the same invocation pushes. Refs pointing at the same commit are analyzed once, and ref deletions (an all-zero local sha) are skipped — a deleted ref exports no code. All Git commands in `pre-push` and its descendants run with `GIT_NO_REPLACE_OBJECTS=1`: object resolution, equality checks, temporary checkout, and gate records use the original pushed objects, regardless of local replacement refs (PR #442 review 5361127076). Untracked inputs are checked repository-wide because tests, imported helpers, and fixtures outside the maintained source trees can affect coverage.
- **Hook coverage boundary (issue #433):** the hooks do not cover every commit-creation path; for example, `git am` can still create commits without running the gate at creation. The complete inventory and command-specific distinctions are maintained only in [Known Finding: Uncovered Commit-Creation Paths](docs/development/quality-gate-enforcement.md#known-finding-uncovered-commit-creation-paths). These are implementation gaps, not exemptions from the required gate or permission to bypass it. The enabled `pre-push` hook still analyzes each pushed ref at its own commit state as described above; push-time analysis does not make those creation paths gated.
- When SonarQube reports a failure or improvement on new code, inspect and fix every reported issue, rerun the gate, and repeat until the Quality Gate is `OK` and new-code unresolved issues are zero. Do not bypass hooks or hide findings with broad exclusions, `NOSONAR`, or rule suppression; a documented false-positive exception requires explicit repository-owner approval.
- Every fully passing gate run appends a one-line JSON summary record — UTC timestamp, gated index tree, HEAD at run time, Quality Gate status, new-code unresolved issue count, and frontend and Rust line coverage — to a **pending file inside `.git`** (`plotweave-gate-history.pending`, never to the tracked file mid-operation: commit-side writes would leave unstaged changes that abort rebases, checkouts, and merges updating `docs/development/gate-history.jsonl`; PR #415 评审 5338815626). After the `pre-push` gates for all pushed refs pass (each slow-path run records the pushed commit itself as `head`, so every push-path record's `head` is a commit that was actually pushed — issue #405), `scripts/gate-history.sh materialize` folds the pending lines into the versioned `docs/development/gate-history.jsonl` and clears the pending file, draining under the same mutex the gate holds so a concurrently passing run cannot lose its record — a lock-wait timeout warns and leaves the lines pending for the next push (issue #355; PR #415 评审 5339243902). That versioned file preserves the executor's self-reported gate conclusions, associated with Git tree objects; matching `git rev-parse <commit>^{tree}` to a record's `tree` establishes only that a claim about that content exists, not that the gate executed or passed. The unsigned, unchained ledger is not independently verifiable proof, and its partial coverage cannot establish the status of every commit (issue #431; reproducible matching, coverage, and `head` mismatch checks are in [Gate Run Evidence Record](docs/development/quality-gate-evidence.md#gate-run-evidence-record-issue-355)); raw scan artifacts (`coverage/`, `.scannerwork/`, `src-tauri/target/`) stay unversioned, and no token ever enters a record. Both writes are best-effort — a failure warns and never blocks an already-passing gate — and only fully passing runs are recorded. Materialized lines are unstaged until staged into the next commit; stage them together with the next change instead of committing the file alone.
- The gate is deliberately a single uniform cost on every gated hook; there is no fast lane. That decision, its measured baseline, and the triggers that would reopen it are recorded in [Quality Gate Cost Decision](docs/development/quality-gate-cost.md) (issue #356; the issue #404 commit-creation wiring extends it to more commands without adding any cheaper variant; issue #355 adds the evidence record without adding any cheaper variant; issue #405 routes the push path per pushed ref — the same complete gate relocated to the pushed commit's state, with a measured slow-path cost, not a cheaper variant). It relaxes nothing above — treat any local workflow that appears to skip part of the gate as a defect, not as sanctioned.

## Change Classification

Classify requested work before editing:

| Class | Includes |
| --- | --- |
| Read-only | Investigation, search, review, Q&A — no writes |
| Editorial Documentation | Markdown with no governance, contract, security, deployment, or process meaning |
| Normative / Governance Documentation | Markdown or instructions that define governance, contracts, security, deployment, or process behavior |
| Source | Application, library, or test code |
| Configuration | Build, CI, deployment, environment, or infrastructure config |
| Operational | A build, release, deployment, rollback, or runbook action that produces a retained or distributed artifact or mutates a running, shared, or external system |

Read-only work and editorial documentation need no authorization beyond the task itself. Normative/governance documentation, source, and configuration work follow the Execution Workflow and Version-Control Safety sections below. Operational work additionally requires explicit authorization from the repository owner before execution because it is outward-facing or produces retained artifacts. Running tests, static checks, type checks, or a local verification compile is not operational work when its disposable output is deleted before task completion and no running, shared, or external system is mutated. If that boundary is exceeded, classify the action under the highest applicable class instead.

Test-driven development applies to source-code features and reproducible defect fixes: write the smallest failing behavior or regression test before the production-code change, observe the expected failure, then implement and keep the suite green. A pure documentation-only change does not require a Red-Green-Refactor cycle.

Tests MUST NOT read repository-versioned source or documentation as opaque text and assert ordinary prose, exact phrasing, substring presence or occurrence counts, physical line counts, formatting, section placement, or implementation layout. Verify semantics through the language/compiler or the configured parser or validator. An exact-text assertion is permitted only when that textual form is itself an authoritative contract, such as a stable clause ID, required heading, wire or golden fixture, schema token, command contract, or machine-readable diagnostic code; the test MUST cite that contract. A fixture created solely to exercise a parser or validator MAY contain the exact text needed to represent its grammar, but its assertions SHOULD target semantic outcomes or stable diagnostic codes instead of ordinary wording.

### Key State And Invariant Matrix

Before changing production code for a feature or reproducible defect fix, agents MUST record a concise, risk-based matrix of the affected behavior in the task plan, an existing relevant design/test document, or the pull-request description. Reuse and update an existing matrix when available; a new standalone document is not required. Pure documentation changes do not require this matrix.

- Each row MUST identify the precondition/state, action or transition (including relevant event ordering), expected observable outcome, invariant that must remain true, and corresponding test or explicit verification gap. An invariant is a property that must hold across the relevant transitions, not merely an expected result for one example.
- Select dimensions relevant to the change: lifecycle transitions, success and failure states, input and contract boundaries, retries and recovery, concurrent or out-of-order completion, and consistency across components or persistence boundaries. Record why a material dimension is not applicable or an identified case remains unverified. Prioritize by user impact and realistic triggers within the repository's threat model; exhaustive Cartesian-product coverage is not required.
- Cover both the normal path and applicable failure or recovery transitions. Identify the owner of each invariant and the entry points that can affect it, so a guard or assertion on one path does not leave another path unchecked.
- Use the matrix to select the smallest failing behavior or regression test before implementation, then extend tests for the other selected cases as needed. Assert observable behavior and contract semantics at the layer that owns the invariant; a mocked call assertion alone does not establish an outcome across component or storage boundaries.
- When a fix adds or changes a state, retry, guard, or recovery path, agents MUST update the matrix and assess adjacent transitions and alternative entry points governed by the same invariant. Add regression coverage for newly affected behavior within the authorized scope, rather than testing only the reported example.
- Before declaring completion, map the selected cases to verification results and disclose remaining gaps and their rationale. Test counts, line coverage, and a passing static-analysis gate do not substitute for this evidence. The matrix does not expand task authorization or override the existing severity, known-boundary, or review-convergence policies.

## Execution Workflow

1. Read this guide and every more-specific instruction that applies to the requested scope.
2. Inspect the relevant code, documentation, build files, and current worktree before proposing or making changes.
3. Classify the change. Read-only work needs no task branch. Keep an existing authorized task branch or worktree. When files will change and no authorized task branch exists, follow the version-control policy below.
4. Search for existing internal capabilities and choose the smallest coherent change that meets the request.
5. For source-code features and reproducible defect fixes, record the Key State And Invariant Matrix before production-code changes. Implement only the approved scope and preserve unrelated worktree changes.
6. Run the narrowest relevant non-interactive checks, then the broader checks required by the affected Scope Routing rows. Delete disposable verification output before task completion and report the result.
7. Update every document, index, or cross-reference the change makes stale. When an issue's resolution differs from the existing design, the same change MUST update the affected design documents (including the relevant topic under `docs/data-model/` and `docs/ui-design.md` where applicable) to reflect the accepted outcome. Update the relevant design sections, distinguish implemented behavior from planned work and retained boundaries, and link the issue or resolving PR; an issue comment or change log alone does not replace updating the design itself. This synchronization MUST be complete before declaring the issue resolved or closing it.
8. Report changed files, verification results, known limitations, and stable evidence. Do not claim completion while required work remains.

## Scope Routing

For each affected path or operation, evaluate the rows below in listed order and stop at the first matching row. A change with multiple affected paths or operations applies the independently matched row for each one.

| Scope | Read first | Working directory | Verification command | Notes |
| --- | --- | --- | --- | --- |
| `AGENTS.md` and any companion agent entry-point files (e.g., `CLAUDE.md`) | This guide's Non-Negotiable Gates, Execution Workflow, and Version-Control Safety sections | repository root | None configured — perform a structured review and report that no automated check exists | Documentation-only changes do not require Red-Green-Refactor. |
| `README.md`, `docs/**` | This guide | repository root | None configured — perform a structured review and report that no automated check exists | Documentation-only changes do not require Red-Green-Refactor. |
| `.githooks/**`, `scripts/**`, and `sonar-project.properties` | This guide's Non-Negotiable Gates, Security, and Version-Control Safety sections | repository root | `npm run check:size && npm test -- scripts` | Versioned local Git hooks, the shared SonarQube incremental zero-issue gate (new code only), and the Prettier formatter-entry behavior tests. Install hooks with `npm run hooks:install`. |
| `.github/**` | This guide's Non-Negotiable Gates and Version-Control Safety sections | repository root | `npx prettier --check .github` (本地语法/格式) + PR 上的 ci 工作流运行（行为检查） | GitHub Actions CI（issue #228）：`ci.yml` 面向 dev 的 PR/push 执行 Scope Routing 各行的路由检查；不运行 Sonar（服务在本机，托管 runner 不可达）——Sonar 与覆盖率保留在本地门禁，CI 不削弱它。Runner 为 `macos-15`（与本机目标平台一致）；凭据与日志不引入密钥。 |
| `src/**` and root frontend manifests or config (e.g., `package.json`, `tsconfig.json`, `vite.config.*`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.nvmrc`) | This guide and `docs/development/software-engineering-standard.md` + `docs/development/typescript-standard.md` | repository root | `npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build && npm test` | React Flow（`@xyflow/react`）/ TypeScript frontend rendered inside the Tauri webview. npm is the package manager; the Node version is pinned by `.nvmrc` (24.18.0). Formatting is Prettier's responsibility (`npm run format` / `format:check`, configured by `.prettierrc.json` and `.prettierignore`); ESLint owns code quality rules, and the Rust backend stays with `cargo fmt`. Production source is checked beyond `strict` via `npm run typecheck:strict` (`noUncheckedIndexedAccess` for index reads, issue #230, and `exactOptionalPropertyTypes` for optional-field existence, issue #231; test files excluded — scope, `*.test-d.ts` contract probes, and rules in `docs/development/typescript-standard.md`); the same check runs inside `scripts/check-static.sh` for the Git/Sonar gates. Architecture invariants are machine-guarded in `npm test`: `src/moduleGraph.test.ts` asserts an acyclic module graph, model-layer purity, and the shell→feature runtime direction (`shellEditorRuntimeViolations`, issue #399). |
| `src-tauri/**` and root `rust-toolchain.toml` | This guide and `docs/development/software-engineering-standard.md` + `docs/development/rust-standard.md` | `src-tauri` | `npm --prefix .. run check:size && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` | Rust backend and Tauri shell: commands, persistence, and native integrations live here. `npm --prefix ..` runs the repository-root size guard before Cargo checks, using the Node version pinned by `.nvmrc` (24.18.0); Rust-only changes require this local check as well (issue #432). CI runs the same repository-wide guard in the frontend job, including all Rust source. `clippy --all-targets` additionally lints test targets so test-code diagnostics cannot accumulate (issue #166). `cargo test` includes the file-granularity module-graph acyclicity guard (`src/module_graph.rs`, `#[cfg(test)]`-gated, issue #399) alongside the `media_format_leaf` leaf-boundary regression (issue #146). The Rust toolchain is pinned by `rust-toolchain.toml` at the repository root (1.95.0 with `rustfmt` and `clippy`; issue #167); upgrades follow the policy in `docs/development/rust-standard.md` and route through this row's checks. |

If no Scope Routing row matches, discover and run the narrowest relevant non-interactive check for every affected path. If no automated check exists, perform a structured review, report that no configured automated check was available, and record what was inspected instead of inventing a command.

Before adding the first maintained source or configuration path for a new service, package, language, or platform, add its explicit Scope Routing row in the same change, including applicable standards, working directory, and non-interactive verification command. The fallback above supports discovery and exceptional unmatched paths; it MUST NOT become the permanent route for a maintained source or configuration area.

Whenever the package manager, npm scripts, workspace layout, or toolchain versions change, update the routing rows above in the same change so they always reflect the actual commands.

## Security

- Validate external input at trust boundaries.
- Apply least privilege to users, services, credentials, and infrastructure.
- Use approved libraries for cryptography, authentication, and authorization.
- Avoid unsafe command construction, raw query concatenation, and untrusted deserialization.

## Version-Control Safety

- Inspect the worktree before changing branches, pulling, staging, or committing.
- Stage explicit approved paths and inspect the staged diff before committing.
- Do not run destructive or externally publishing operations without the authorization required by the project.
- After cloning, run `npm run hooks:install` so Git uses the versioned `.githooks/` directory. Do not unset `core.hooksPath` or use `--no-verify` to evade the required SonarQube checks.

### Branch, Pull Request, And Commit Policy

The current non-protected branch or worktree present when a user starts a task is authorized for that task unless the user says otherwise. A different or new branch is authorized only when the user explicitly selects or requests it, or an already-authorized task tool creates and assigns it. A branch name alone never authorizes task scope or external writes.

- **Protected branches**: `main` and `dev` are protected branches; no direct commits or pushes to either branch. `dev` is the sole active integration baseline; `main` is additionally a reserved placeholder that has never carried an integration commit since the initial one (issue #354), so the documented model matches the actual `git` history.
- **Task-branch base**: `dev` is the development baseline and the sole permitted base for every new task branch. Create from the current local `dev`; `main` MUST NOT be used as a branch point. Do not fetch, pull, or otherwise synchronize `dev` unless the user authorizes it.
- **Task branches**: keep an existing authorized task branch or worktree rather than switching solely to satisfy naming. When a new branch is needed, create it from the current local `dev` after inspecting the worktree, using a project-appropriate `feature/`, `fix/`, `docs/`, or `chore/` prefix or a tool-mandated prefix.
- **Task pull requests**: target `dev`; include the verification commands run and their results. `main` is not yet enabled and receives no pull requests of any kind; once the repository owner enables it through the recorded release decision described below — made before any `main`-bound pull request exists, so the enabling pull request itself is never in conflict with this rule — only repository-integration or release pull requests from `dev` may target `main`, and ordinary task branches MUST NOT target `main`.
- **Commits**: use Conventional Commits (`<type>(<scope>): <imperative summary>`) with an appropriate type such as `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, or `build`.
- **Commit-creation and push gate**: `pre-commit`, `pre-merge-commit`, and `prepare-commit-msg` all run `scripts/sonar-quality-gate.sh` before their commit is created, and `pre-push` reruns it before anything leaves the machine, once per pushed ref at that ref's commit state (issue #405: current-worktree fast path when the pushed commit is provably identical to the working tree, otherwise a gated temporary-worktree checkout of it — decided per unique commit; identical commits once; deletions skipped); after a passing run the commit-creating hooks record the gated index tree via `scripts/gate-tree-marker.sh` (issue #404) so `prepare-commit-msg` skips only a tree the same Git process (PID + start time, issue #429) has just gated; missing or mismatched process identity requires the complete gate. This wiring still leaves commit-creation paths uncovered; see the [hook coverage boundary](#non-negotiable-gates) and its linked authoritative inventory. The invoking environment MUST set `SONAR_HOST_URL` explicitly and MAY supply authentication through `SONAR_TOKEN`, falling back to `PLOTWEAVE_SONAR_TOKEN` (for example exported from `~/.zshrc`); neither value belongs in versioned files. The script serializes gate runs per worktree, runs the shared static checks (Prettier format check + ESLint with zero warnings + `npm run check:size` + `npm run typecheck:strict`, fail-fast) first, then generates and validates fresh frontend and Rust LCOV coverage before publishing an analysis, invokes `sonar-scanner` with Quality Gate waiting enabled, checks the final Quality Gate is `OK`, and separately requires the unresolved issue count on new code (`sinceLeakPeriod`, the project's New Code period) to be zero — historical issues on overall code do not block the operation and are triaged separately. Fix findings and rerun until clean; concurrent runs, invalid coverage, missing configuration or tools, authentication failures, an unavailable SonarQube server, timeouts, malformed responses, failed tests, and non-zero new-code findings all block the operation.
- **Bootstrap exception**: the single initial commit that establishes this policy and the project baseline files on `dev` is authorized despite the no-direct-commits rule; every later change follows the policy above.

This policy uses protected `dev` as the task pull-request target, sole task-branch base, and sole active integration baseline, while protected `main` is a reserved integration or release placeholder that has never carried an integration commit (issue #354). Enable `main` only at the first formal release — a version tag or a distributed package: enablement is the repository owner's recorded release decision, made before any `main`-bound pull request exists, and it authorizes a single repository-integration pull request from `dev` to `main` as `main`'s first pull request. Update this section and the `README.md` branch model in the same change so the documented release model matches the resulting `git` history. Revisit this policy with a recorded governance decision once additional long-lived release branches, independent component versioning, or multi-environment promotion is needed.

## Verification And Completion Evidence

- For a source-code feature or reproducible defect fix, use Red-Green-Refactor: first add the smallest focused test, observe it fail for the expected missing behavior, then implement and observe focused and routed checks pass. Pure documentation changes do not manufacture a failing source test; they undergo a structured review instead.
- Run focused checks first and broader checks when shared behavior is affected.
- For changes requiring a Key State And Invariant Matrix, include its location, verification results, and remaining gaps in the completion evidence.
- Use the exact commands and working directories from Scope Routing.
- Report skipped, blocked, or failing checks with their full reason.
- Prefer stable evidence such as commit identifiers, immutable links, symbols, headings, and command-result summaries. Treat mutable line numbers as supplementary evidence only.
- Completion requires the requested behavior, required documentation, required checks, and required evidence — not merely an implementation attempt.

## Review And Response Policy

This section calibrates how review findings (automated reviewers included) are
classified and answered. It governs response decisions, not the SonarQube
gate: gate requirements in Non-Negotiable Gates remain hard and separate.

### Threat Model

PlotWeave is a local single-user desktop application; project data lives in
the user's own application-data directory. Findings are in scope when they
concern: single-point dirty data amplifying into global failure (home list
cleared, `list` rejecting wholesale), save races that lose user edits,
save-boundary/load-normalization contract mismatches that silently erase or
corrupt data, and non-idempotent operations (delete/copy/move) acting on the
wrong target.

Out of scope: time-of-check/time-of-use swaps of the `projects/` tree by a
concurrent local attacker under the same user identity. The anchored-handle +
no-follow classification + identity binding already implemented in the
`src-tauri/src/store/` persistence modules (`persist.rs` and siblings)
constitutes sufficient defense-in-depth; residual
windows beyond it (and the absence of comparable identities on non-Unix
platforms, which have no build or test coverage in this repository) are
documented, not fixed.

### Severity Calibration

- **P1** — user data loss, corruption, or exposure that is realistically
  reachable through normal use, common dirty data, or known system behavior.
  Blocks merge; must be fixed.
- **P2** — contract inconsistencies or robustness defects whose trigger
  requires rare dirty data, narrow race windows, or extreme values. Fix or
  register as a known boundary, at the owner's discretion.
- **P3** — further layers of defense-in-depth, defensive validation, missing
  documentation comments on public symbols, extreme-value handling, and
  anything overlapping the out-of-scope threat model. Record, do not fix;
  never blocks merge.

"Repair-visibility" findings (one side pre-cleans a defect so the other side's
`repaired` detection cannot see it) default to P2: frontend normalization is
the designated single repair point, and field-by-field pass-through fidelity
is not escalated per instance. Findings about missing intent documentation on
exported symbols are always P3.

### Review Rounds And Convergence

- **Round budget.** Each pushed commit accepts at most one follow-up review
  round. A repeated finding without new evidence is resolved-without-change
  by citing the existing disposition. A follow-up finding counts as new only
  when it states at least one of: a new trigger condition, a newly violated
  contract, or a regression introduced by the fix. Non-P1 findings beyond
  the budget are closed without modification. Once the budget is spent,
  automatic rework pauses and any further findings go to the repository
  owner for adjudication; exhausting the budget never by itself approves,
  merges, or passes any gate.
- **Bulk triage.** When findings arrive in bulk, deduplicate first, then
  classify each as a genuine defect, a pre-existing issue, an out-of-scope
  suggestion, or a false positive, and summarize the classification. Fixes
  that are necessary and already inside the authorized task scope MAY
  proceed without waiting. Present the summary and let the repository owner
  choose the response set only when a response would expand scope, accept a
  risk, or change a contract. Do not force a human decision for every
  batch, and do not default to fixing everything.
- **Recording dispositions.** No exemption markers (`NOSONAR`, rule
  suppressions) go into code. Every review thread containing a finding,
  suggestion, or question MUST receive a substantive reply in that original
  thread, including automated reviews, duplicates, and findings resolved
  without change. A pull-request summary, issue note, reaction, or resolved
  flag alone does not satisfy this requirement. Pure acknowledgments and
  informational notifications require no reply. Duplicate findings MAY
  link to a canonical disposition, but each thread still needs a brief
  explanation of why that disposition applies. Existing replies need only
  be updated when new evidence or a changed disposition warrants it.

### Review Thread Reply Structure

Replies MUST use the following ordered, labeled fields; concise entries are
sufficient, and the labels MAY be translated to match the conversation:

1. **Disposition** — state whether the finding is fixed, resolved without
   change, deferred, or awaiting an owner decision. Include its triage
   classification and severity where applicable; answer any reviewer question
   directly.
2. **Rationale and change** — explain the relevant trigger, contract, or
   policy and what changed, or why no change is appropriate. For fixes, cite
   the resolving commit and relevant symbols or documentation sections.
   If a fix is only local, say so explicitly and add the commit reference
   once available; do not imply it has been pushed.
3. **Verification** — provide relevant commands and results, or stable
   evidence supporting a no-change decision. Disclose checks not run and
   their reasons; do not claim verification that has not occurred.
4. **Follow-up** — state remaining work, limitations, and any required owner
   decision, linking a tracking issue or prior disposition when applicable.
   Explicitly say when no follow-up remains.

A substantive reply MUST precede marking a thread resolved. Deferred work
or a pending owner decision MUST NOT be described as fixed. These reply
requirements do not expand fix scope, override the review-round budget or
severity policy, or authorize external posting beyond the user's granted
scope. If posting is not authorized or is blocked, prepare the reply and
report the pending thread and reason; do not claim the thread was answered.

### Issue Reporting

Issues in the GitHub tracker MUST follow
[docs/development/issue-standard.md](docs/development/issue-standard.md):
the title uses the format `P<1|2|3>(<scope>): <summary>` — the severity
calibration above, applied to the tracker, with the scope token of the
affected area; Conventional-Commit type words (`fix`, `refactor`, …) do
not belong in issue titles. The standard also fixes the required severity
label, the `known-boundary` label for recorded dispositions, and the body
structure per issue kind.

## Sources Of Truth

| Concern | Authoritative path or discovery command |
| --- | --- |
| Product vision, stack overview, and branch model | `README.md` |
| Data-model topics and legacy chapter mapping | `docs/data-model/README.md` and `docs/data-model.md` |
| Engineering standards: size/complexity, boundaries, patterns, testing | `docs/development/software-engineering-standard.md` (+ language standards alongside) |
| Issue tracker conventions: severity, titles, labels, body structure | `docs/development/issue-standard.md` |
| Versioned source, configuration, and implementation evidence | Git commit and pull-request revisions |
| Project structure, dependencies, and executable commands | Discover from root and service manifests/build files as they are added |
