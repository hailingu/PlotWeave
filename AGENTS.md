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
- Keep each function, method, hook, component, or Rust `fn` at or below **80 physical lines**, counted from its signature line through its closing brace (blank lines and inline comments inside the body count). This applies to the same trees as the file-size caps and covers test helpers and fixture builders alike. Functions that already exceed the cap when this rule lands are grandfathered at their current line count: they MUST NOT grow past it, and the next substantive change SHOULD split them (extract helpers, subcomponents, or fixtures) until they comply. New functions MUST comply from creation.
- Keep the versioned `pre-commit` and `pre-push` hooks enabled. Before any commit or push, generate fresh coverage, run SonarQube, wait for the Quality Gate, and require zero unresolved issues. A failed or unavailable gate blocks the Git operation.
- When SonarQube reports a failure or improvement, inspect and fix every reported issue, rerun the gate, and repeat until the Quality Gate is `OK` and unresolved issues are zero. Do not bypass hooks or hide findings with broad exclusions, `NOSONAR`, or rule suppression; a documented false-positive exception requires explicit repository-owner approval.

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

## Execution Workflow

1. Read this guide and every more-specific instruction that applies to the requested scope.
2. Inspect the relevant code, documentation, build files, and current worktree before proposing or making changes.
3. Classify the change. Read-only work needs no task branch. Keep an existing authorized task branch or worktree. When files will change and no authorized task branch exists, follow the version-control policy below.
4. Search for existing internal capabilities and choose the smallest coherent change that meets the request.
5. Implement only the approved scope and preserve unrelated worktree changes.
6. Run the narrowest relevant non-interactive checks, then the broader checks required by the affected Scope Routing rows. Delete disposable verification output before task completion and report the result.
7. Update every document, index, or cross-reference the change makes stale.
8. Report changed files, verification results, known limitations, and stable evidence. Do not claim completion while required work remains.

## Scope Routing

For each affected path or operation, evaluate the rows below in listed order and stop at the first matching row. A change with multiple affected paths or operations applies the independently matched row for each one.

| Scope | Read first | Working directory | Verification command | Notes |
| --- | --- | --- | --- | --- |
| `AGENTS.md` and any companion agent entry-point files (e.g., `CLAUDE.md`) | This guide's Non-Negotiable Gates, Execution Workflow, and Version-Control Safety sections | repository root | None configured — perform a structured review and report that no automated check exists | Documentation-only changes do not require Red-Green-Refactor. |
| `README.md`, `docs/**` | This guide | repository root | None configured — perform a structured review and report that no automated check exists | Documentation-only changes do not require Red-Green-Refactor. |
| `.githooks/**`, `scripts/**`, and `sonar-project.properties` | This guide's Non-Negotiable Gates, Security, and Version-Control Safety sections | repository root | `npm test -- scripts/sonar-quality-gate.test.ts` | Versioned local Git hooks and the shared SonarQube zero-issue gate. Install hooks with `npm run hooks:install`. |
| `src/**` and root frontend manifests or config (e.g., `package.json`, `tsconfig.json`, `vite.config.*`, `eslint.config.js`, `.nvmrc`) | This guide and `docs/development/software-engineering-standard.md` + `docs/development/typescript-standard.md` | repository root | `npm run lint && npm run build && npm test` | React Flow（`@xyflow/react`）/ TypeScript frontend rendered inside the Tauri webview. npm is the package manager; the Node version is pinned by `.nvmrc` (24.18.0). |
| `src-tauri/**` | This guide and `docs/development/software-engineering-standard.md` + `docs/development/rust-standard.md` | `src-tauri` | `cargo fmt --check && cargo clippy -- -D warnings && cargo test` | Rust backend and Tauri shell: commands, persistence, and native integrations live here. |

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

- **Protected branches**: `main` and `dev` are protected branches; no direct commits or pushes to either branch.
- **Task-branch base**: `dev` is the development baseline and the sole permitted base for every new task branch. Create from the current local `dev`; `main` MUST NOT be used as a branch point. Do not fetch, pull, or otherwise synchronize `dev` unless the user authorizes it.
- **Task branches**: keep an existing authorized task branch or worktree rather than switching solely to satisfy naming. When a new branch is needed, create it from the current local `dev` after inspecting the worktree, using a project-appropriate `feature/`, `fix/`, `docs/`, or `chore/` prefix or a tool-mandated prefix.
- **Task pull requests**: target `dev`; include the verification commands run and their results. Only a repository-integration or release pull request from `dev` may target `main`; ordinary task branches MUST NOT target `main`.
- **Commits**: use Conventional Commits (`<type>(<scope>): <imperative summary>`) with an appropriate type such as `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, or `build`.
- **Pre-commit and pre-push gate**: both hooks run `scripts/sonar-quality-gate.sh`. The invoking environment MUST set `SONAR_HOST_URL` explicitly and MAY supply authentication through `SONAR_TOKEN`, falling back to `PLOTWEAVE_SONAR_TOKEN` (for example exported from `~/.zshrc`); neither value belongs in versioned files. The script serializes gate runs per worktree, generates and validates fresh frontend LCOV coverage before publishing an analysis, invokes `sonar-scanner` with Quality Gate waiting enabled, checks the final Quality Gate is `OK`, and separately requires the project's unresolved issue count to be zero. Fix findings and rerun until clean; concurrent runs, invalid coverage, missing configuration or tools, authentication failures, an unavailable SonarQube server, timeouts, malformed responses, failed tests, and non-zero findings all block the operation.
- **Bootstrap exception**: the single initial commit that establishes this policy and the project baseline files on `dev` is authorized despite the no-direct-commits rule; every later change follows the policy above.

This policy uses protected `dev` as the task pull-request target and sole task-branch base, protected `main` as the integration or release target, and temporary task branches. Revisit it with a recorded governance decision once additional long-lived release branches, independent component versioning, or multi-environment promotion is needed.

## Verification And Completion Evidence

- For a source-code feature or reproducible defect fix, use Red-Green-Refactor: first add the smallest focused test, observe it fail for the expected missing behavior, then implement and observe focused and routed checks pass. Pure documentation changes do not manufacture a failing source test; they undergo a structured review instead.
- Run focused checks first and broader checks when shared behavior is affected.
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
no-follow classification + identity binding already implemented in
`src-tauri/src/store.rs` constitutes sufficient defense-in-depth; residual
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
  suppressions) go into code. Ordinary suggestions resolved without change
  MAY be recorded briefly — one line (location + reason) in the pull
  request or an issue, so the decision stays traceable. Blocking or
  disputed findings MUST be answered in the original review thread with the
  resolving commit (or the decision not to change), the rationale, and the
  verification evidence; a one-line pull-request or issue note alone does
  not close them.

## Sources Of Truth

| Concern | Authoritative path or discovery command |
| --- | --- |
| Product vision, stack overview, and branch model | `README.md` |
| Engineering standards: size/complexity, boundaries, patterns, testing | `docs/development/software-engineering-standard.md` (+ language standards alongside) |
| Versioned source, configuration, and implementation evidence | Git commit and pull-request revisions |
| Project structure, dependencies, and executable commands | Discover from root and service manifests/build files as they are added |
