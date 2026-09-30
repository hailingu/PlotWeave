# Quality Gate Cost Decision

**Applies to**: the versioned local Git hooks (`.githooks/pre-commit`,
`.githooks/pre-merge-commit`, `.githooks/prepare-commit-msg`,
`.githooks/pre-push`), `scripts/sonar-quality-gate.sh`, and the gate-run
dedup marker helper `scripts/gate-tree-marker.sh` (issue #404). Like the root
`AGENTS.md` and the other standards under `docs/development/`, this file is
written in English for agent interoperability.

**Last reviewed**: 2026-09-30

**Status**: Active — accepted decision. Recorded 2026-09-27, resolving
[issue #356](https://github.com/hailingu/PlotWeave/issues/356); extended
2026-09-28 by the issue #404 commit-creation wiring (same complete gate,
more commands routed through it — see
[What The Gate Actually Enforces](#what-the-gate-actually-enforces)) and by
the issue #355 evidence record (one summary line per fully passing run,
written to a pending file inside `.git` and materialized into the versioned
file after a passing push — see
[Gate Run Evidence Record](#gate-run-evidence-record-issue-355)); baseline
refreshed 2026-09-30 on the pinned Node toolchain, measuring the complete
gate as extended — that refresh fired the first distribution
reconsideration trigger, and the revisit it requires is recorded with the
alternatives (see [Measured Baseline](#measured-baseline) and
[Status Of The Alternatives](#status-of-the-alternatives)); and extended
2026-09-30 by the issue #405 push-path per-ref gating — a deliberate
gate-strength change authorized by that issue: `pre-push` now reads the refs
Git hands it on stdin and analyzes every pushed commit at its own state,
with a measured slow-path cost recorded alongside the baseline (see
[Push-Path Per-Ref Gating](#push-path-per-ref-gating-issue-405) and
[Push-Path Slow-Path Cost](#push-path-slow-path-cost-2026-09-30-issue-405)).

## Required Reading

- [AGENTS.md](../../AGENTS.md) — the Non-Negotiable Gates and
  Version-Control Safety sections. This file records *one* decision about that
  gate; it never relaxes it.
- [Software Engineering Standard](software-engineering-standard.md) — the
  repository-wide baseline for change design and documented exceptions.

## Decision

**The gate stays a single, uniform cost. There is no fast lane.**

Every gated command runs the same complete sequence:

1. `scripts/check-static.sh` — Prettier format check, ESLint with zero
   warnings, `typecheck:strict`. Fail-fast, ahead of all coverage work.
2. `npm run test:coverage` — the full frontend suite, serialized to LCOV and
   threshold-checked against the versioned 80% overall line-coverage floor
   (issue #393).
3. `scripts/rust-coverage.sh` — `cargo-llvm-cov` over the library and the
   `media_format_leaf` test target, after which the same 80% floor is
   re-checked on both LCOV reports (frontend and Rust) before any analysis is
   published (issue #393).
4. `sonar-scanner` publishing the analysis, then waiting for the Quality Gate,
   then a separate check that new-code unresolved issues are zero.
5. Since issue #355, a fully passing run appends one summary record to a
   pending file inside `.git`, and the `pre-push` hook materializes pending
   lines into the versioned `docs/development/gate-history.jsonl` after its
   gate passes (see
   [Gate Run Evidence Record](#gate-run-evidence-record-issue-355)). This step
   observes and records; it checks nothing and adds no variant of the gate.

Since the issue #404 wiring, the gated commands are `git commit` and
`git push` as before, plus every other commit-creating porcelain that has a
wireable pre-creation hook: non-fast-forward merges (`pre-merge-commit`), and
`git revert` / `git cherry-pick` / rebase replays
(`prepare-commit-msg`). Only `pre-commit` and `pre-merge-commit` record the
just-gated index tree through `scripts/gate-tree-marker.sh` — its sole
same-operation consumer is the `prepare-commit-msg` that follows them — and
`prepare-commit-msg` skips a run only when that exact tree was gated within
the same operation moments earlier: an ordinary `git commit` still pays
exactly one gate run, and a merge pays exactly one (`pre-merge-commit` gates,
`prepare-commit-msg` deduplicates). A fallback gate run in
`prepare-commit-msg` (revert / cherry-pick / rebase replay / `--no-verify`)
writes **no** marker: nothing downstream in that operation could consume it,
so writing it would only enable reuse by a later operation (评审 4120239723).
Commands with no wireable hook (see the table) remain
ungated. The marker is **single-use** (评审 4120128545): a successful
`check` consumes it, so a later operation — including a same-tree
`--no-verify` commit — cannot reuse it. The marker is a dedup hint, not a
trust boundary: any mismatch, expiry, or corruption resolves to running the
gate. One narrow residue remains: a gate pass whose commit never reaches
`prepare-commit-msg` (for example an editor abort) leaves an unconsumed
marker that one later same-tree operation within the TTL could consume;
closing it fully would require an operation identity shared across the two
hooks, which Git does not provide.

There is no cheaper or faster variant of that sequence, and no configuration
that selects one. Which commit-producing commands actually reach it — and which
currently do not — is recorded precisely in
[What The Gate Actually Enforces](#what-the-gate-actually-enforces).

This is option C of issue #356. The issue did not argue for lower quality
requirements; it argued that the "cost tier" question deserved one explicit
decision and a recorded baseline. Both now exist.

## Status Of The Alternatives

Options A and B were evaluated against the measurement below and are recorded
here as **considered and declined**, not as pending work.

| Option | Change | Measured upside | Why declined |
| --- | --- | ---: | --- |
| A | Make Rust coverage reuse build artifacts | ≤16.6s per run (23% of one gate run) | The cost has no single hotspot — the four phases are near-evenly split, so the best-case saving is bounded and small relative to the risk of changing `cargo-llvm-cov` report semantics. |
| B | Tier the check set between pre-commit and pre-push | **58.5s per commit** (80% of the pre-commit phase) | The largest lever by a wide margin, and a governance change rather than an optimization: it decides *when* checks run, and leaves an interval in which a commit exists locally without SonarQube having run. The uniform gate was judged worth that cost. |
| C | Accept the cost, record the decision and a baseline | none (by design) | Adopted. |

The upside figures in this table are the founding baseline's (2026-09-27).
The [2026-09-30 refresh](#refreshed-baseline-2026-09-30) changed the
distribution materially: the Rust coverage phase is now the largest single
phase (~48.3s, ~36% of a run), so option A's bounded upside grows to
~48.3s per run — still short of the ~40% single-phase mark at which option
A would deserve a real design — and A's `cargo-llvm-cov`
report-semantics risk is unchanged. The "no single hotspot" wording above
describes the founding measurement and is retained as history. Losing the
even split fires the first distribution
[Reconsideration Trigger](#reconsideration-triggers); the revisit that
trigger requires is this change itself — re-measured as a three-run median
and re-assessed here — and the decline stands on the refreshed numbers
(PR #441 评审 5360118900).

### What option B would actually mean

B is only coherent in one variant that preserves the "Sonar runs on the push
path" invariant, and the upside depends entirely on reading that variant
correctly. The stage allocation is:

- **before** — pre-commit runs the complete gate (72.9s), pre-push runs the
  complete gate (72.9s): 145.8s per commit-and-push cycle;
- **after (option B)** — pre-commit runs `scripts/check-static.sh` only
  (14.4s), pre-push runs the complete gate unchanged (72.9s): 87.3s per cycle.

The saving is therefore **72.9 − 14.4 = 58.5s per commit**, not 14.4s. The
14.4s figure is the *remaining* pre-commit cost after the split, and quoting it
as the saving understates option B by roughly a factor of four. At the
~25 eligible commits/day below that is about 24 minutes per day, a ~40%
reduction in total gate time.

A review of this record caught exactly that mislabelling; the figure above is
the corrected one. Note that option B would *not* weaken the gate's coverage —
`check-static.sh` still runs on every `git commit`, and SonarQube analysis plus
the Quality Gate still run before anything reaches the remote. Within the scope
the gate actually covers (see
[What The Gate Actually Enforces](#what-the-gate-actually-enforces)), what option
B changes is that a commit can be created locally before the coverage and
scanner phases have run for it.

The cycle figures in this subsection use the founding baseline. At the
[refreshed 2026-09-30 baseline](#refreshed-baseline-2026-09-30) the same
reading gives: complete gate 135.5s, static-only pre-commit 12.8s, so the
saving would be 135.5 − 12.8 ≈ 122.7s per commit — roughly 53 minutes per
day at ~26 eligible commits/day, a ~45% reduction in total gate time. The
governance assessment, and the decline, are unchanged; only the arithmetic
moved.

Declining A and B is a statement about today's numbers, not a permanent
refusal. See [Reconsideration Triggers](#reconsideration-triggers).

## Impact On Gate Strength

Two records live in this file and must not be conflated (评审 4120364296):

- The original **#356 decision (2026-09-27) changed no gate behavior at
  all** — it was a documentation and measurement change only.
- The **issue #404 extension (2026-09-28) deliberately changes gate
  behavior**: it adds the complete gate to previously-ungated commit-creation
  paths — automatic non-fast-forward merges, `git revert`, `git cherry-pick`,
  rebase replays, and commit-side `--no-verify`. Within the paths #356 already
  gated (ordinary `git commit` and `git push`), behavior and per-operation
  cost are unchanged: exactly one gate run of the same complete sequence. The
  extension only strengthens coverage; it introduces no weaker variant, skip,
  or fast path.
- The **issue #393 extension (2026-09-29) also deliberately changes gate
  behavior**: it adds a versioned, failable 80% overall line-coverage floor —
  vitest `thresholds` inside `npm run test:coverage`, plus a re-check of both
  LCOV reports in `scripts/sonar-quality-gate.sh` before the analysis is
  published. The floor matches the local SonarQube server's Quality Gate
  coverage condition, so the gate no longer depends on that unversioned
  server-side condition for its coverage conclusion. It introduces no
  cheaper variant, skip, or fast path, and relaxes nothing.
- The **issue #405 extension (2026-09-30) also deliberately changes gate
  behavior**: the push path no longer scans whatever happens to be checked
  out. `pre-push` reads the refs Git hands it on stdin and runs the complete
  gate once per unique pushed commit, at that commit's own state — see
  [Push-Path Per-Ref Gating](#push-path-per-ref-gating-issue-405). It
  introduces no cheaper variant of the sequence: the fast path is the same
  complete sequence in the current working tree, taken only when that tree
  is provably identical to the pushed commit, and the slow path is the same
  complete sequence in a temporary worktree checked out at the pushed
  commit.

The following remain in force exactly as written in `AGENTS.md`, and nothing
in this file is an exception to them:

- All four hooks stay enabled (`pre-commit`, `pre-merge-commit`,
  `prepare-commit-msg`, `pre-push`) and each runs the complete
  `sonar-quality-gate.sh`; the tree marker only deduplicates within one
  commit-creating operation and never selects a cheaper check set.
- `--no-verify` remains prohibited, and `core.hooksPath` remains pointed at the
  versioned `.githooks/` directory.
- No new skip, allowlist, or "fast" path is introduced. There is no environment
  variable, flag, or branch condition that reduces the check set.
- SonarQube analysis and the Quality Gate still execute on the push path.
- A failed or unavailable gate still blocks the Git operation.
- The New Code period incremental zeroing rule is unchanged: new-code unresolved
  issues must be zero, while historical issues on overall code stay triaged
  separately.

The "no environment variable reduces the check set" claim above has one
documented boundary: the gate scripts intentionally expose
`PLOTWEAVE_NPM_BIN`, `PLOTWEAVE_SONAR_SCANNER_BIN`,
`PLOTWEAVE_CARGO_LLVM_COV_BIN`, `PLOTWEAVE_CURL_BIN`, `PLOTWEAVE_NODE_BIN`,
and the report-path overrides
(`PLOTWEAVE_COVERAGE_REPORT_PATH`, `PLOTWEAVE_RUST_COVERAGE_REPORT_PATH`,
`PLOTWEAVE_SONAR_REPORT_PATH`) as **test-only injection points**, and the
hooks invoke the gate script with the environment inherited so those
variables are passed through (评审
4115318775). A shell that exports them can point the gate at substitute
executables or pre-written reports and thereby skip real checks. These
overrides exist for the gate's own test suite; using them to bypass the
gate is the same class of explicit evasion as `--no-verify`, which
`AGENTS.md` prohibits. Closing the injection points in hook invocations is
a hardening change to gate behavior and out of scope for this record.
`PLOTWEAVE_GATE_MARKER_PATH` and `PLOTWEAVE_GATE_MARKER_TTL`
(`scripts/gate-tree-marker.sh`, issue #404) belong to the same class: they
steer the dedup marker and its expiry, so exporting a pre-written matching
marker can suppress the `prepare-commit-msg` gate run. Same disposition —
test-only injection, explicit evasion to use it that way.
`PLOTWEAVE_GATE_HISTORY_PATH` and `PLOTWEAVE_GATE_PENDING_PATH`
(`scripts/sonar-quality-gate.sh` / `scripts/gate-history.sh`, issue #355)
also belong to the test-only injection class: they redirect only where the
evidence record is written, so they cannot skip any check, but pointing them
elsewhere does remove the in-repository evidence for that run.
`PLOTWEAVE_GATE_REPOSITORY_ROOT` (`scripts/sonar-quality-gate.sh`,
`scripts/check-static.sh`, `scripts/rust-coverage.sh`, issue #405) belongs
to the same injection class but is stronger than the path overrides above:
it redirects **which tree the gate analyzes**, and the `pre-push` slow path
uses it to point the current gate scripts at the pushed commit's temporary
worktree. A shell that exports it can therefore analyze an arbitrary
directory instead of the state a Git operation is about to record or push —
the same class of explicit evasion as `--no-verify`, prohibited by
`AGENTS.md`.

Anyone reading a faster local workflow elsewhere in this repository should
treat it as a defect in that workflow, not as sanctioned by this decision.

## Push-Path Per-Ref Gating (issue #405)

Before issue #405, `.githooks/pre-push` read no input and always scanned the
checked-out working tree, so pushing a non-checked-out ref, several refs at
once, or the checked-out branch with a dirty tree let states reach the
remote that the gate had never analyzed (the founding record of that finding
is retained below in
[Known Finding: Push Scans The Checked-Out Tree, Not The Pushed
Ref](#known-finding-push-scans-the-checked-out-tree-not-the-pushed-ref)).
The issue #405 fix, wired 2026-09-30, closes it:

- **Read stdin.** The hook consumes every line Git hands it
  (`<local ref> <local sha> <remote ref> <remote sha>`) before dispatching,
  so no child process can consume the hook's input, and the ref list cannot
  be influenced by gate execution.
- **Fast path — current working tree.** Taken only when the pushed commit
  (the local sha peeled to a commit, so annotated tags analyze the commit
  they point at) equals `HEAD` **and** the tree is provably identical to it:
  `git diff --quiet HEAD` (no unstaged or staged tracked differences),
  `git diff --cached --quiet HEAD` (index equality, so the record's
  `write-tree` key matches the pushed tree), and no untracked non-ignored
  file in the trees the gate reads (`src/`, `src-tauri/`, `scripts/`,
  `.githooks/`) or at the repository root (root-level config files such as
  an untracked `vitest.config.ts` can rewrite gate conclusions, so they must
  share the pushed tree's provenance; untracked content in other directories
  cannot weaken the gate — Prettier may over-block on it, never under-block).
  The complete gate then runs exactly as before, at the same cost.
- **Slow path — temporary worktree.** Every other case (a non-checked-out
  ref, a dirty worktree, multiple distinct commits) is checked out with
  `git worktree add --detach` into a `mktemp` directory, dependencies are
  installed from that tree's lockfiles (`npm ci`), and the **current**
  gate scripts run the complete sequence with
  `PLOTWEAVE_GATE_REPOSITORY_ROOT` pointing at that worktree. The user's
  working tree is never touched; the temporary worktree is removed after the
  run (best-effort `git worktree remove --force` on every exit path;
  residue is disk waste only, `git worktree prune` recovers it).
- **Dedup and deletions.** Refs pointing at the same commit (a branch and
  its tag) are analyzed once; a ref deletion (all-zero local sha) exports no
  code and is skipped; a malformed ref line or a local sha that does not
  peel to a commit fails closed. Every ref line is analyzed or rejected —
  none is silently ignored.
- **Evidence and serialization.** Slow-path runs write their gate-history
  record through the main worktree's pending file and take the main
  worktree's gate lock, so fast path, slow path, and `materialize` stay
  serialized on one mutex and the record's `tree`/`head` are the pushed
  commit's (issue #355 semantics unchanged). All refs must pass before
  `materialize` runs; a failure blocks the push with earlier passing records
  left pending for the next successful push.

**Known boundaries.** The fast path's equality proof is bounded by what git
can see: ignored files (e.g., a file hidden by `.git/info/exclude` inside
`src/`) and tracked differences masked by `skip-worktree` or
`assume-unchanged` are invisible to `git diff` / `git status` and can still
make the analyzed content differ from the pushed commit — the pre-#405
residuals, now narrowed from "always possible" to "fast path only". The slow
path's pristine checkout closes both. The slow-path subprocesses also strip
the worktree-localization variables git exports to commit-creating hooks
(`GIT_INDEX_FILE`, `GIT_PREFIX`, …): they resolve relative to the invoking
worktree and are invalid inside a temporary worktree — without the strip,
a gate run nested inside a commit hook (which is exactly how this
repository's own script tests execute under `npm run test:coverage`) would
break the slow path. Both paths analyze with the gate
definition of the current working tree (uniform-gate rule), so a pushed tree
older than the tooling itself fails closed if it lacks `package-lock.json`
(`npm ci`) or the files the gate needs; pushing such an ancient tree requires
checking it out first. Using `--no-verify` on the push remains prohibited and
is unaffected by this wiring.

The measured cost of both paths is recorded in
[Measured Baseline](#measured-baseline): the fast path is the unchanged
complete-gate cost (the refreshed baseline measures it); the slow path adds
dependency installation and cold caches and was measured once on landing —
see
[Push-Path Slow-Path Cost](#push-path-slow-path-cost-2026-09-30-issue-405).

## Gate Run Evidence Record (issue #355)

Before issue #355, every artifact behind a passing gate conclusion —
`coverage/`, `.scannerwork/`, `src-tauri/target/` — was local-only and
gitignored, and `.github/workflows/ci.yml` deliberately does not run Sonar.
The repository therefore held no durable, third-party-verifiable credential
that any given commit had passed the Quality Gate with zero new-code
unresolved issues. Issue #355 offered three drafts; this repository adopted
**option A** (a versioned summary record). Option B cannot work for the core
claim because hosted CI cannot reach the local SonarQube server, so its
artifacts would only ever prove the reachable subset; option C would register
the gap without closing it.

**What is recorded.** After a run passes the *complete* sequence — static
checks, both coverage reports, the scanner, Quality Gate `OK`, and zero
new-code unresolved issues — `scripts/sonar-quality-gate.sh` appends exactly
one JSON line to a pending file inside `.git`
(`plotweave-gate-history.pending`), never to the tracked file mid-operation
(PR #415 评审 5338815626: a commit-side write to the tracked file leaves an
unstaged change that aborts the next rebase replay, checkout, or merge
updating that file). After the `pre-push` gate passes, the hook runs
`scripts/gate-history.sh materialize`, which folds the pending lines into the
versioned `docs/development/gate-history.jsonl` and clears the pending file.
Each record line:

| Field | Meaning |
| --- | --- |
| `timestamp` | UTC ISO-8601 time of the record append, second precision. |
| `tree` | The gated **index tree** (`git write-tree`) — the same key the dedup marker uses, and the value a reader compares against `git rev-parse <commit>^{tree}` to verify that a commit's content passed a complete gate run. |
| `head` | The commit `HEAD` pointed at during the run — the parent of the commit being created on pre-commit-style paths, the tip being pushed on `pre-push`. Provenance context, not the verification key. |
| `qualityGate` | The Quality Gate status for this run's analysis (`OK`; only fully passing runs are recorded). |
| `newCodeUnresolvedIssues` | Unresolved issue count on new code for this run (`0`; only fully passing runs are recorded). |
| `frontendLineCoveragePercent` / `rustLineCoveragePercent` | Line coverage computed from the same LCOV reports this run submitted (`DA` records with execution count > 0 count as covered). |

**Verification recipe.** To check that commit `C` passed a complete gate run,
compute `git rev-parse C^{tree}` and find a record whose `tree` equals it with
`qualityGate` `OK` and `newCodeUnresolvedIssues` `0`. The record is a durable
claim made by the gate tooling itself at gate time, versioned in git history;
unlike pre-#355 practice, the claim no longer depends on the executor's word.

**Deliberate properties and boundaries.**

- *Success-only.* Failed or blocked runs append nothing: no Git operation
  results from them, so there is nothing to justify later. The log therefore
  proves "this tree passed", never "this tree was the only thing examined".
- *Best-effort writes, drain under the gate lock.* A pending-append failure
  (permissions, disk) prints a warning to stderr and does not block the
  already-passing gate — the same philosophy as the tree marker.
  `materialize` waits for the **same mutex the gate holds** (second-granularity
  polling of the `.sonar-gate.lock` directory) and drains
  pending → versioned while holding it: record appends happen only under
  that lock, so a concurrently passing gate cannot have its record truncated
  away in the drain window (PR #415 评审 5339243902). A lock-wait timeout —
  or a malformed timeout configuration — warns and leaves the lines pending
  for the next push; materialize never blocks or fails the push. If the
  append into the versioned file succeeds but the pending-file truncation
  fails, the next materialize can duplicate lines — benign under log
  semantics — and a materialize killed with SIGKILL can leave the stale lock
  that gates already treat as requiring cleanup. Evidence must not become a
  new way to fail a clean gate or push.
- *Materialize-at-push, one-commit lag.* Commit-creating paths write only to
  the pending file inside `.git`, so they never dirty the tracked file and
  never interfere with subsequent Git steps; the versioned file is touched
  only after a passing `pre-push`, at which no further tree operation is
  pending in that command. Because the evidence file must itself pass the
  gate, materialized lines are unstaged until the next commit stages them —
  stage them together with the next change; committing the file alone burns
  a full gate run on a record-only commit. Records for commit-side runs of
  commits that are never pushed stay in the local pending file: nothing
  leaves the machine, so there is no external claim to verify.
- *Working tree vs. index key.* The gate analyzes the working tree (see
  [Known Finding: Push Scans The Checked-Out Tree, Not The Pushed
  Ref](#known-finding-push-scans-the-checked-out-tree-not-the-pushed-ref)),
  while `tree` records the index tree, matching the marker's key. With
  unstaged or untracked differences the run validated more (or different)
  content than the key identifies; the caveats of that known finding apply
  to records unchanged.
- *Append-only growth.* One line per fully passing run, no rotation; the
  file is a log of runs, not a derived state that can be rebuilt.
- *No secrets.* Records carry hashes, counts, and percentages only. Tokens
  never reach the record path (the gate passes them via stdin/environment
  exclusively), and raw scan artifacts stay unversioned — the issue #355
  acceptance criteria require both.

## What The Gate Actually Enforces

The bullets above describe intent. This section records the verified
*enforcement* boundary, so that no reader overstates the guarantee. It was
measured on 2026-09-27 against git 2.48.1 with isolated logging hooks selected
through `core.hooksPath`. The table records command-related observations in
the tested modes; shared index-write and ref-update callbacks are explained
below, rather than claiming an exhaustive trace for every command variant.

Since the issue #404 wiring this repository wires four hooks:
`.githooks/pre-commit`, `.githooks/pre-merge-commit`,
`.githooks/prepare-commit-msg`, and `.githooks/pre-push`, plus the shared
dedup helper `scripts/gate-tree-marker.sh`. There is no `commit-msg`,
`post-commit`, `post-merge`, `pre-rebase`, `post-rewrite`,
`pre-applypatch`, `applypatch-msg`, `reference-transaction`, or
`post-index-change`. The table below was measured on 2026-09-27 against
git 2.48.1 with only `pre-commit` and `pre-push` wired; the "Gate analyzes
this commit?" column has been updated for the new wiring where the measured
hook set determines it, and the hook lists themselves are unchanged
measurements — the wired hooks now make the automatic merge / revert /
cherry-pick / rebase-replay / commit-side `--no-verify` paths reach the
gate.

Since the issue #405 fix (2026-09-30), every push-side mismatch this
inventory records — a pushed ref whose state differs from the checked-out
tree — is closed: `pre-push` reads stdin and analyzes each pushed ref at
that ref's own commit (fast path in the checked-out tree only under the
provable-equality preconditions, otherwise a temporary-worktree checkout;
see
[Push-Path Per-Ref Gating](#push-path-per-ref-gating-issue-405)). The
per-row `#405` mentions below are retained as the pre-fix measurement of
which commands could produce such a mismatch; they identify the push-side
exposure those rows had before the fix, not a live gap.

| Command that creates a commit | Observed hooks (shared callbacks also described below) | Gate analyzes this commit? |
| --- | --- | :---: |
| `git commit` (without `--amend`) | `post-index-change` on index writes; `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit` | yes |
| `git commit --amend` | `post-index-change` on index writes; `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit`, then `post-rewrite amend` unless `--no-post-rewrite` | yes |
| `git merge` (automatic, conflict-free non-fast-forward merge commit) | `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-merge` | **yes** (issue #404: wired `pre-merge-commit`) |
| `git merge --autostash` (dirty tracked worktree) | merge hooks above; autostash creates ref-less stash commits with no hook | **yes** for the merge commit; the autostash objects stay ungated |
| `git pull` (default merge mode, diverged upstream) | `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-merge`; `reference-transaction` on fetch | **yes** (issue #404: wired `pre-merge-commit`) |
| `git pull --autostash` (default merge mode, dirty tracked worktree) | pull merge hooks above; autostash creates ref-less stash commits with no hook | **yes** for the merge commit; the autostash objects stay ungated |
| `git merge --continue` after resolving conflicts | `post-index-change`; `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit` | yes |
| `git revert` (automatic, conflict-free commit) | `prepare-commit-msg` + `post-commit` | **yes** (issue #404: wired `prepare-commit-msg`) |
| `git revert --continue` after resolving conflicts | `post-index-change`; `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit` | yes |
| `git cherry-pick` (automatic, conflict-free commit) | `prepare-commit-msg` + `post-commit` | **yes** (issue #404: wired `prepare-commit-msg`) |
| `git cherry-pick --continue` after resolving conflicts | `post-index-change`; `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit` | yes |
| `git rebase` replaying commits onto a new base | `pre-rebase` once, then `prepare-commit-msg` + `post-commit` per replayed commit, `post-rewrite` once at the end | **yes** (issue #404: wired `prepare-commit-msg`, one full gate per replayed commit) |
| `git rebase --autostash` (dirty tracked worktree) | rebase hooks above; autostash creates ref-less stash commits with no hook | **yes** for replayed commits; the autostash objects stay ungated |
| `git rebase --update-refs` (other branches in the rebased range) | rebase hooks above; secondary branches move via `reference-transaction` only — no gate for their new tips | **yes** for replayed commits; secondary tips **no** * |
| `git rebase --continue` after resolving a conflict | `post-index-change`, `prepare-commit-msg`, `post-commit`, `post-rewrite`; no `pre-commit` | **yes** (issue #404: wired `prepare-commit-msg`) |
| `git am` applying a patch series | `applypatch-msg`, `pre-applypatch`, `post-applypatch` — none wired | **no** |
| `git stash push` / `git stash` / `git stash save` (tracked changes) | `reference-transaction`; no commit-creation hooks | **no** * |
| `git stash push -u` / `--all` | `reference-transaction`; no commit-creation hooks; additionally creates an ungated third "untracked files" parent commit | **no** * |
| `git stash create [<message>]` (tracked changes) | `post-index-change` on index writes; no commit-creation or ref-update hooks | **no** |
| `git notes add` / `append` / `edit` / `copy` / `remove` / `merge` / `prune` | `reference-transaction`; no commit-creation hooks | **no** * |
| `git commit-tree` + `git update-ref` (plumbing) | `reference-transaction`; no commit-creation hooks | **no** * |
| `git hash-object -t commit -w --stdin` + `git update-ref` (plumbing) | `reference-transaction` on ref update only; `hash-object` itself fires no hook | **no** * |
| `git replace [-f] <object> <replacement>` / `git replace --graft <commit> [<parent>…]` / `git replace --edit <commit>` / `git replace --convert-graft-file` | `reference-transaction`; no commit-creation hooks | **no** * |
| `git fast-import` (`commit <ref>` stream) | `reference-transaction`; no commit-creation hooks | **no** * |
| `git quiltimport` (applies a quilt patchset to the current branch) | `post-index-change`; `reference-transaction`; no commit-creation hooks | **no** |
| `git filter-branch` (history rewrite) | none measured here (see note) | **no** * |
| `git lfs migrate import` / `export` / `import --no-rewrite` (extension) | reviewer probe only (git-lfs 3.4.1): shared index/ref/checkout callbacks, no commit-creation hooks; not measured here (git-lfs absent) | **no** * |
| `git subtree split --prefix=<dir> --branch <branch>` | `reference-transaction`; no commit-creation hooks | **no** * |
| `git subtree split --prefix=<dir> [<commit>]` (no `--branch`) | none measured here; no ref updated | **no** ** |
| `git subtree merge --prefix=<prefix> <commit>` (automatic non-fast-forward merge) | `post-index-change`; `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-merge`; shared `reference-transaction` | **yes** (issue #404: wired `pre-merge-commit`) |
| `git subtree merge --prefix=<prefix> --squash <commit>` | `post-index-change`; `reference-transaction`; no commit-creation hooks; additionally creates a ref-less synthetic squash commit | **no** |
| `git subtree pull --prefix=<prefix> <repository> <ref>` (automatic non-fast-forward merge) | `reference-transaction` on fetch; then the subtree merge hooks above | **yes** (issue #404: wired `pre-merge-commit`) |
| `git subtree pull --prefix=<prefix> <repository> <ref> --squash` | `reference-transaction` on fetch; then the subtree merge `--squash` hooks above | **no** |
| `git subtree split --rejoin --prefix=<prefix>` | split commits have no commit hook; automatic rejoin merge fires `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-merge`; shared index/ref callbacks | **yes** for the rejoin merge (issue #404: wired `pre-merge-commit`); split commits **no** |
| `git subtree split --rejoin --squash --prefix=<prefix>` | `post-index-change`; `reference-transaction`; no commit-creation hooks; additionally creates a ref-less synthetic squash commit | **no** |
| `git subtree push --prefix=<prefix> <repository> <refspec>` | `pre-push` receives split tip; `reference-transaction` may update `refs/remotes/origin/*` after the push; no commit-creation or checked-out-branch ref-update hook | **no** (for generated split commits) |
| `git subtree push --prefix=<prefix> --branch <branch> <repository> <refspec>` | `reference-transaction` on the new local branch; then `pre-push` receives split tip | **no** (for generated split commits; branch creation is a #404 closure candidate) |
| `git subtree push --rejoin --prefix=<prefix> <repository> <refspec>` (automatic conflict-free rejoin) | rejoin merge: `post-index-change`, `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `reference-transaction` on the checked-out branch, `post-merge`; then `pre-push` receives split tip | **yes** for the rejoin merge (issue #404: wired `pre-merge-commit`); generated split commits **no** |
| `git subtree push --rejoin --squash --prefix=<prefix> <repository> <refspec>` | rejoin merge with `--squash` hooks; additionally creates a ref-less synthetic squash commit; then `pre-push` receives split tip | **no** (for rejoin merge, synthetic squash commit, and generated split commits) |
| `git subtree add --prefix=<prefix> <commit>` | `post-index-change` on index writes; `reference-transaction`; no commit-creation hooks | **no** |
| `git subtree add --prefix=<prefix> --squash <commit>` | `post-index-change` on index writes; `reference-transaction`; no commit-creation hooks; additionally creates a ref-less synthetic squash commit | **no** |
| `git merge --squash` / `--no-commit` followed by `git commit` | `pre-commit`, … | yes |
| `git commit --no-verify` (without `--amend`) | `post-index-change` on index writes; `prepare-commit-msg`, `post-commit` | **yes** (issue #404: `--no-verify` skips `pre-commit` but not `prepare-commit-msg`) |
| `git merge --no-verify` | `prepare-commit-msg`, `post-merge` | **yes** (issue #404: wired `prepare-commit-msg` still fires) |
| `git commit --amend --no-verify` | `post-index-change` on index writes; `prepare-commit-msg`, `post-commit`, then `post-rewrite amend` unless `--no-post-rewrite` | **yes** (issue #404: wired `prepare-commit-msg` still fires) |

\* These rows produce commits under refs that are **pushable by explicit
refspec** — `git push <remote> refs/stash:refs/heads/…`, `refs/notes/*`,
`refs/replace/*`, `refs/heads/<branch>` from the subtree split, or the branch
`update-ref` just created — so each carried the same
remote-facing gap tracked in
[Known Finding: Push Scans The Checked-Out Tree, Not The Pushed
Ref](#known-finding-push-scans-the-checked-out-tree-not-the-pushed-ref):
before the issue #405 fix, `pre-push` analyzed the checked-out tree, not the
pushed ref (评审 4115165662, 4115165667). Since that fix (2026-09-30) the
gap is closed — each pushed ref is analyzed at its own commit. The
`commit-tree` and `hash-object` rows
additionally have a direct-OID push variant that causes no local
`reference-transaction` — `update-ref` is optional for both, and the
returned OID can be pushed as-is; `pre-push` still receives the OID and can
block the push. See the commit-tree paragraph below.

\*\* This row produces a commit object without updating any ref, so no local
`reference-transaction` fires for it. The commit can be published in two
ways: installed on a local branch first (`git update-ref refs/heads/…
<oid>`), which fires `reference-transaction` and is a #404 closure
candidate, then pushed normally; or pushed directly by OID (`git push
<remote> <oid>:refs/heads/…`), which is the #405 push-side gap.

`post-index-change` is a shared index-write callback, as specified by its
[Git contract](https://git-scm.com/docs/githooks#_post_index_change), rather
than a commit-creation gate (评审 4115577716). Any command that reaches that
index-writing path can invoke it; its occurrence and count depend on the
index writes performed. Git 2.48.1 probes of ordinary commit, amend, both
corresponding `--no-verify` forms, and `commit --only A` all invoked it.
When `pre-commit` was enabled, the observed index callbacks preceded it;
`--only A` produced two index callbacks rather than one. All five commands
committed the expected tree and exited 0 with `post-index-change` configured
to exit 1, so it cannot supply a blocking gate. Other rows do not enumerate
every shared index callback; their index-write traces were not remeasured
here, and omission from a row does not mean the callback cannot fire.
This repository does not wire it, so the Gate column remains unchanged.

Every command in this table also fires `reference-transaction` on the ref
updates it performs — measured on git 2.48.1 for `git commit`
(`refs/heads/*`), `git merge`, `git cherry-pick`, and `git stash push`
(`refs/stash`) — and the per-row hook lists omit it because it is not
commit-creation-specific (评审 4114992022). The `git filter-branch` row is
the exception: its entry here is unverified because our Git 2.48.1
measurement fired no hook at all while a Git 2.43 run reported it (评审
4115347192), so do not treat `reference-transaction` as a verified closure
for that path. This repository does not wire it,
so the Gate column is unaffected. Note that a nonzero exit in its `prepared`
state aborts the ref update, which makes it the one hook type that could in
principle gate these paths; whether to do so is a #404 hook-design question,
not part of this decision.

`git commit --amend` also calls `post-rewrite` with argument `amend` after
`post-commit`, as the [post-rewrite contract](https://git-scm.com/docs/githooks#_post_rewrite)
specifies (评审 4115510916). Measured on Git 2.48.1: both ordinary amend and
amend with `--no-verify` invoked it with the old/new commit OIDs on stdin;
both completed and changed `HEAD` even when that hook exited 1. It therefore
cannot block the rewrite. `--no-verify` skips `pre-commit` and `commit-msg`,
not `post-rewrite`; the separate `--no-post-rewrite` option suppresses the
latter, also confirmed by the probe. Ordinary amend reaches the existing
`pre-commit` gate; since the issue #404 wiring, amend with `--no-verify` is
still gated, because `--no-verify` does not skip `prepare-commit-msg`, which
finds no reusable marker and runs the complete gate.

`git revert` and `git cherry-pick` do not accept `--no-verify` at all
(`git revert -h` / `git cherry-pick -h` list no such option), so they are
absent from the bypass rows rather than bypassable through them. Their automatic
commits run `prepare-commit-msg` and `post-commit` — **not** `commit-msg`, which
`githooks(5)` documents as applying to `git commit` and `git merge`
(评审 4114854376). Like the rebase row, `post-commit` fires only once the commit
exists and git ignores its exit status, so it cannot implement a blocking gate
either. `post-merge` on the merge rows is likewise after the fact: it fires
after the merge has completed and cannot block it.

`git pull` in its default merge mode is the same automatic merge commit as
`git merge` plus a fetch: measured on git 2.48.1 with a diverged upstream, it
fired `reference-transaction` on the fetch, then `pre-merge-commit`,
`prepare-commit-msg`, `commit-msg`, and `post-merge` — no `pre-commit`
(评审 4117872584). Since the issue #404 wiring the wired `pre-merge-commit`
gates that merge commit like `git merge` itself. Its `--rebase` modes enter
the rebase path, whose replayed commits are gated per pick through
`prepare-commit-msg`. `git pull` is the commonest entry point for merges, so
it is listed separately rather than folded into the `git merge` row.

`--autostash` on `merge`, `pull`, or `rebase` adds another ref-less path:
the option stashes dirty tracked changes before the operation and pops them
after, creating stash commit objects without any commit-creation hook or
`reference-transaction` for those objects (评审 4117983619). Measured on git
2.48.1, `git merge --autostash` printed the temporary stash OID and created
both the stash and index-parent commits with no hook firing for them; the
printed OID remains directly pushable, giving these variants the same
ref-less #404/#405 boundary already documented for `stash create`.

The conflict path is different for merge, revert, and cherry-pick. In Git
2.48.1 fixtures, each automatic command stopped on a content conflict; after
resolving and staging the file, its documented `--continue` command invoked
`pre-commit` before creating the resulting commit. That runs this repository's
gate, subject to the working-tree-versus-commit-tree boundary above. These
continuations are therefore covered by `pre-commit` (评审 4115865924); since
the issue #404 wiring, their automatic conflict-free commit paths are covered
as well — merges through `pre-merge-commit`, revert and cherry-pick through
`prepare-commit-msg` — so both paths of these commands are now gated. A
conflict-resolved
`git rebase --continue` was also measured: it ran `prepare-commit-msg`,
`post-commit`, and `post-rewrite`, but not `pre-commit`; since the issue #404
wiring, `prepare-commit-msg` runs the gate, so the continuation is covered
like every other replayed rebase commit.

`git rebase` and `git am` were measured on 2026-09-27 (git 2.48.1, isolated
hook log, two commits replayed / one patch applied) with this repository's
wiring absent, so the rows above record which hooks *would* fire: a
commit-producing rebase runs `pre-rebase` once and then `prepare-commit-msg`
and `post-commit` per replayed commit — **`pre-commit` and `commit-msg` never
fire** — and `post-rewrite` once after the replay, whose exit status git
ignores, so it cannot implement a blocking gate either (评审 4114827177);
the command-specific hooks for `git am` are the applypatch family, none of
which this repository wires. Shared index/ref callbacks are covered above.
Since the issue #404 wiring these two paths diverge: the wired
`prepare-commit-msg` gates each replayed rebase commit, while `git am`
remains the ungated path — none of the applypatch family is wired. With
`--update-refs`,
rebase additionally moves other local branches that point into the rebased
range: measured on git 2.48.1, `git rebase --update-refs --onto <newbase>
HEAD~2` moved a secondary branch to the replayed intermediate commit via
`reference-transaction` only (评审 4119009208). That branch's tree can
differ from the checked-out rebased tip, so pushing it makes `pre-push`
scan the checked-out tree rather than the branch being published — the same
#405 pushed-ref mismatch, marked `*` in the table.

`git stash push` with tracked changes creates its entry commits under
`refs/stash` — the stash commit plus its index parent — without running any
commit-creation hook (评审 4114895001); the `git-stash` documentation likewise
describes a stash entry as a commit. The bare `git stash` shorthand and the
legacy `git stash save` form behave identically — measured on git 2.48.1,
each created the stash and index-parent commits with only shared index/ref
callbacks firing (评审 4118565852). With `-u` / `--all`, the stash commit
gains a third "untracked files" parent commit that is likewise created
ungated. Stashed work normally re-enters the tree
through `git stash pop` / `apply`, which create no commits, and becomes
commits only through the paths this table already records. Its ref-update hook is
`reference-transaction` on the `refs/stash` update, and aborting that update
in the `prepared` state does prevent the entry — measured: with such a hook
`git stash push` fails with exit 128 ("ref updates aborted by hook") and
`refs/stash` keeps its previous value — though the entry's objects are
already written by then (评审 4114992022). Stash therefore remains within
#404's hook-design scope rather than being excluded as unwireable.

`git stash create [<message>]` is a separate, ref-less path. With modified
tracked content, it returns the new stash commit's OID without changing
`HEAD`, `refs/stash`, or another local ref. A Git 2.48.1 probe recorded only
shared `post-index-change` callbacks (four index writes); no commit-creation
hook or `reference-transaction` fired. That callback cannot block the object
creation. If the returned OID is pushed directly, `pre-push` receives that
OID while the gate scans the checked-out tree. In the probe, an untracked
source file remained in the working tree but was absent from the stash commit
tree, demonstrating the #405 mismatch. A local `reference-transaction` hook
cannot close the creation path unless the object is first installed in a ref, so that
limitation belongs in #404's hook-design inventory as well.

The stash commits are also pushable: an explicit refspec such as
`git push <remote> refs/stash:refs/heads/…`, or `--mirror`, copies the stash
commit to the remote while `pre-push` analyzes the unrelated checked-out
tree (评审 4115165662) — measured on git 2.48.1, `git push <remote>
refs/stash:refs/heads/stashed` created a new remote branch holding the exact
stash commit. So stash does not, after all, stay purely local; its push-side
exposure is the push finding below, tracked there rather than re-counted
here.

`git notes add` / `append` / `edit` / `copy` / `remove` / `merge` / `prune`
likewise create commits under `refs/notes/*` (by default `refs/notes/commits`)
without any commit-creation hook — measured on git 2.48.1, only
`reference-transaction` fires (评审 4115135524, 4117675234, 4117735042).
Notes refs are pushable (`git push origin refs/notes/*`), so this row is
remote-facing in the same sense the push finding is; it is recorded here as
a boundary and its closure — `reference-transaction` in `prepared` state —
is the same #404 option noted for stash, not a separate remedy.

`git replace [-f] <object> <replacement>` points the target at an existing
replacement object, creating `refs/replace/<target-oid>` without any
commit-creation hook — measured on git 2.48.1, only `reference-transaction`
fired (评审 4118343207). The ordinary form shares the same ref-backed
exposure and #404/#405 disposition as the specialized forms below.

`git replace --graft <commit> [<parent>…]` creates a replacement commit with
the target commit's tree and the supplied parent list, then stores it under
`refs/replace/<target-oid>`. Git commands use that replacement by default, so
it can change the effective history seen by local commands without moving a
branch ref. Measured on git 2.48.1 with a two-commit fixture, grafting the
child to have no parent preserved its tree, created a distinct replacement
commit, and fired only `reference-transaction` (in `prepared` and `committed`
states); no commit-creation hook fired. An explicit push of that individual
`refs/replace/<target-oid>` ref installed the replacement ref on a local bare
remote. The local closure is therefore the same #404
`reference-transaction` design question as the other ref-backed paths, and
the explicit-push exposure belongs to #405.

`git replace --edit <commit>` creates the same kind of replacement ref after
editing the commit object in the configured editor. Measured on git 2.48.1
with an isolated commit fixture, changing its message created a distinct
replacement commit under `refs/replace/<target-oid>` and fired only
`reference-transaction` (`prepared` and `committed`); no commit-creation hook
fired. Explicitly pushing that ref to a local bare remote succeeded. Its local
and push-side dispositions are therefore the same #404 and #405 paths as
`--graft`. `git replace --convert-graft-file` converts legacy
`.git/info/grafts` entries into `refs/replace/*` refs; measured on git
2.48.1 with a valid graft, it created the replacement commit and fired only
`reference-transaction` (`prepared` and `committed`), no commit-creation
hook (评审 4117675234). Its local and push-side dispositions are the same
#404 and #405 paths as `--graft` and `--edit`.

The plumbing path is uncovered too: `git commit-tree <tree>` creates a
commit object directly, and `git update-ref refs/heads/<branch> <commit>`
places it on branch history, without any commit-creation hook — measured on
git 2.48.1, only `reference-transaction` fired during the ref update
(评审 4115165667). One level lower, `git hash-object -t commit -w --stdin`
writes the commit object itself; measured on git 2.48.1, piping a valid
commit payload created the object with an empty hook log (评审 4117675224).
The resulting OID can then be installed with `update-ref` or pushed
directly, so `commit-tree` is not the lowest-level route after all. Like
the other off-hook paths their local ref-update closure is the same #404
`reference-transaction` question. `git fast-import` reaches the same
place from a stream: its `commit <ref>` command creates the commit and
updates the branch in one step — measured on git 2.48.1, importing one
commit into `refs/heads/imported` fired only `reference-transaction`
(prepared + committed, twice) and no commit-creation hook (评审 4115220196).
Because this repository does not wire that hook, such an import bypasses the
gate on the commit side entirely. `git quiltimport` is the user-facing
counterpart: it applies a quilt patchset onto the current branch, creating
each commit via the same `commit-tree` + `update-ref` plumbing — measured on
git 2.48.1 with a one-patch series, it landed the commit on branch history
with only `post-index-change` and `reference-transaction` firing, no
commit-creation hook (评审 4118728971). `git filter-branch` produced an empty
hook log in our measurement — no commit-creation hook and no
`reference-transaction` (git 2.48.1, `--env-filter` forcing a real rewrite).
The reviewer reports `reference-transaction` firing on Git 2.43 (评审
4115347192); we could not reproduce that here, so we record our measured
result and note the discrepancy rather than assert either way. This
repository does not wire `reference-transaction` regardless, so the gate
does not run for filter-branch; whether the hook is available as a closure
is a #404 question the two measurements leave open.

`git lfs migrate` is the first **extension** path in this inventory rather
than a git built-in. Reviewer probes on Git 2.43 with git-lfs 3.4.1 report
that `import` / `export` (which "rewrite your Git history" per
`git lfs migrate --help`) and `import --no-rewrite` (which creates a new
commit) all changed `HEAD` while firing only shared
index/ref/checkout callbacks — never `pre-commit` (评审 4118866986).
git-lfs is not installed in this measurement environment, so the row
records the reviewer's probe rather than a local measurement. The reviewer's
probe covered the HEAD-only default; the documented multi-ref modes —
`--everything` (migrate commits reachable from all refs) and
`--include-ref` selections — can additionally rewrite **non-checked-out**
branches and tags (评审 4118919110). Those rewritten refs are pushable while
`pre-push` scans only the checked-out tree, so the multi-ref modes carry the
same pushed-ref mismatch as multi-ref `filter-branch`: the #405 push-side
gap, marked `*` in the table. The same
class boundary extends to other third-party history rewriters —
`git filter-repo`, `git-annex` — which operate below the porcelain commit
path like the built-in rewriters above; they have not been probed here
either, so verify a given tool's hook behavior before relying on this
class statement.

`git subtree split --prefix=<dir> --branch <branch>` creates a rewritten
commit chain for the selected subtree and places its tip on the requested
branch. Measured on git 2.48.1 with a two-commit fixture, the split produced
two commits and fired only `reference-transaction` (`prepared` and
`committed`); no commit-creation hook fired. Explicitly pushing the resulting
branch to a local bare remote succeeded. The local ref-update closure is a
#404 `reference-transaction` design question, and pushing that branch while
the hook scans the checked-out tree is the #405 push-side gap.

`git subtree split --prefix=<dir> [<commit>]` without `--branch` is the
ref-less variant: it creates the same rewritten commit chain but prints only
its tip OID without updating any ref, and fires no hook at all (评审
4115953696). Measured on git 2.48.1, an isolated probe returned a new OID
with an empty hook log and `for-each-ref` unchanged. That OID is then
publishable by direct-OID push (`git push <remote> <oid>:refs/heads/…`),
which likewise runs no local hook against the pushed content; the push-side
gap is the same #405 remedy, and no local `reference-transaction` can
intercept the creation before that push.

`git subtree merge --prefix=<prefix> <commit>` and
`git subtree pull --prefix=<prefix> <repository> <ref>` both create a merge
commit on the checked-out branch. With divergent application and subtree
histories, Git 2.48.1 fixtures confirmed two-parent merge commits; each fired
`pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-merge`, shared
index callbacks, and `reference-transaction`, but neither fired `pre-commit`.
`pull` also fetched the source before the merge. The unwired
`pre-merge-commit` and the branch ref transaction are #404 closure candidates;
these commands do not themselves push a ref. If a conflicting merge is
continued with `git merge --continue`, that continuation follows the
`pre-commit` path documented above. With `--squash`, both commands
additionally create a ref-less synthetic squash commit before the merge
(评审 4117872586): `git subtree -h` documents `--squash` for `merge` and
`pull` as well, and the synthetic commit already exists before the branch
transaction, so `reference-transaction` cannot close its creation; its
push-side exposure is the same #405 remedy.

`git subtree split --rejoin --prefix=<prefix>` combines a ref-less split with
a merge back into the current branch. In the automatic, conflict-free path of
a Git 2.48.1 fixture with subtree history and a new subtree change, it created
split commits and a two-parent rejoin merge; the split generation fired no
commit-creation hook, while the rejoin fired `pre-merge-commit`,
`prepare-commit-msg`, `commit-msg`, `post-merge`, and `reference-transaction`,
but not `pre-commit`. The branch
transaction is a #404 candidate for preventing the rejoin from entering local
history, while `pre-merge-commit` could gate the merge if wired. It does not
make the generated split tree the gate's input; if the split tip is pushed
directly, the #405 pushed-ref mismatch applies. With `--squash`, the command
additionally creates a ref-less synthetic squash commit before the rejoin
(评审 4117843430): measured on git 2.48.1, `git subtree split --rejoin
--squash --prefix=<prefix>` produced both a `Squashed '<prefix>/' content`
commit and the rejoin commit, with only `post-index-change` and
`reference-transaction` firing — the `pre-merge-commit` sequence recorded
for the non-squash rejoin did not run. The synthetic commit already exists
before the branch transaction and can be pushed directly by OID, so
`reference-transaction` cannot close its creation; its push-side exposure is
the same #405 remedy.

`git subtree push --prefix=<prefix> <repository> <refspec>` also creates a
rewritten split chain, but pushes its tip directly without leaving a local
split branch. Measured on git 2.48.1 with a two-commit fixture, it created a
two-commit split history and fired no commit-creation hook or checked-out
branch ref update. `pre-push` received the split tip OID while `HEAD` remained
the different full-project commit; the push installed the split tip on the
bare remote. The local `reference-transaction` callback observed in that probe
was for `refs/remotes/origin/<refspec>` after the remote accepted the push, so
it cannot block that outbound update. The command bypasses the commit gate and
the current push hook analyzes the wrong tree. The ordinary form has no
pre-push local ref transaction that can close #404 before the split is pushed;
analyzing the pushed split tip is the #405 disposition.

`git subtree push --prefix=<prefix> --branch <branch> <repository> <refspec>`
differs: it installs the generated split tip on a local branch before
pushing. Measured on git 2.48.1, the command created `refs/heads/<branch>`
with `reference-transaction` (`prepared` and `committed`) before `pre-push`
ran (评审 4117947441). That local ref update is a #404 closure candidate —
`reference-transaction` can reject the branch creation — while the push
itself still scans the checked-out tree, so #405 remains for the pushed
content.

`git subtree push --rejoin --prefix=<prefix> <repository> <refspec>` is a
different path. When the subtree has new commits, `--rejoin` merges the
generated split tip back into the checked-out branch before pushing. In a
Git 2.48.1 fixture with a new subtree commit after an earlier rejoin, the
resulting two-parent merge fired `pre-merge-commit`, `prepare-commit-msg`,
`commit-msg`, `post-merge`, and `reference-transaction` for the checked-out
branch; `pre-push` then received the generated split-tip OID, not the new
rejoin `HEAD`. The Git 2.43 probe reported by review 4115812068 observed the
same key hooks. This makes the rejoin branch update a #404 hook-design
candidate (`reference-transaction` can reject the branch update, and a wired
`pre-merge-commit` could gate the merge). The split commit itself is still not
analyzed by the current gate, and `pre-push` still scans the rejoin working
tree rather than the pushed split tip, so #405 remains. With `--squash`, the
rejoin additionally creates a ref-less synthetic squash commit before the
merge (评审 4117872586): the synthetic commit already exists before the
branch transaction, so `reference-transaction` cannot close its creation;
its push-side exposure is the same #405 remedy.

`git subtree add --prefix=<prefix> <commit>` is another distinct operation:
it installs a merge commit on the checked-out branch. In a Git 2.48.1 fixture
with diverged source and target commits, the command created a two-parent
merge commit containing the prefixed tree. The measured hooks were shared
`post-index-change` and `reference-transaction` callbacks; neither
`pre-commit` nor `pre-merge-commit` ran. This branch-history path belongs in
#404's hook-design inventory; unlike `stash create` and ordinary `subtree
push`, it updates the checked-out branch, so `reference-transaction` is a
possible closure to evaluate there. With `--squash`, the command additionally
creates a ref-less synthetic squash commit before the merge (评审 4117804224):
measured on git 2.48.1, `git subtree add --prefix=<prefix> --squash <commit>`
produced both a `Squashed '<prefix>/' content` commit and the merge commit,
with only `post-index-change` and `reference-transaction` firing. The
synthetic commit already exists before the branch transaction and can be
pushed directly by OID, so `reference-transaction` cannot close the squash
commit itself; its push-side exposure is the same #405 remedy.

`reference-transaction` does **not** close every `commit-tree` path,
though: `update-ref` is optional. A commit object can be pushed directly by
OID — `git push <remote> <oid>:refs/heads/…` — while no local ref ever
points at it, so no local `reference-transaction` fires; `pre-push` runs
but analyzes the unrelated checked-out tree (评审 4115241708). Measured on
git 2.48.1: such a push installed the object on the remote
(`refs/heads/direct`) while the local hook log shows only `pre-push`
reading the pushed OID from stdin and no `reference-transaction` entry. The
absence of that ref-update hook does not prevent `pre-push` from blocking
the operation: a separate Git 2.48.1 probe with `pre-push` exiting 1 rejected
the direct-OID push and left the remote ref absent; with exit 0 the remote
ref received the exact OID. This matches the
[documented pre-push contract](https://git-scm.com/docs/githooks#_pre_push)
(评审 4115477917). The plumbing path therefore splits: the local-ref variant is a #404
`reference-transaction` question; the direct-OID variant is a push-side gap
that only the #405 remedy (analyze the pushed ref) can close.

One qualification applies to the `git commit` rows themselves: the gate
script scans the working tree, while Git records the tree selected for that
invocation. Ordinary index-based commits use the staged contents; pathspecs
and content-selection flags can select a different tree. For an ordinary
index-based commit, working-tree state beyond the index is analyzed but not
committed. With partially staged changes — state A staged, further state B
left unstaged — `pre-commit` runs the checks against A+B and the commit
records A alone (评审 4114992019); the same holds for any untracked file,
whether or not git lists it — untracked files are absent from the index yet
still scanned by the gate, because Prettier, ESLint, and the TypeScript
compiler all read the working tree, and compiler inclusion is independent
of git's ignore rules. An untracked file excluded through `.git/info/exclude`
leaves `git status` clean apart from the staged entry, yet this repository's
`tsconfig.json` includes all of `src`, so `typecheck:strict` sees that
ignored definition (评审 4115165665) (评审 4115036983).
Measured on git 2.48.1: a `pre-commit` hook observed an unstaged definition
and, in a second run, an untracked one that the resulting commit did not
contain; a third run confirmed an ignored (`info/exclude`) file is likewise
invisible to `git status` yet visible to the hook. That state can, for example, supply a definition A depends on,
letting the gate pass while the commit alone does not build. This is the
commit-side analog of the push-path finding below — same root cause, the
gate scans the working tree — recorded here as a boundary rather than fixed.

Matching the original index is insufficient for path-limited commits
(评审 4115548805). With both A and B modified and staged, `git commit
--only A` and the implicit pathspec form `git commit A` record new A plus
old B, while the gate reads new A plus new B. In Git 2.48.1 isolated probes,
the working tree matched the original index before both commands, and that
index retained both staged versions afterward. `git commit --amend --only`
without paths likewise omitted the staged changes and retained the previous
tree; ordinary `git commit` and `git commit --include A` recorded both
staged versions in the same fixture. These results match Git's
[content-selection contract](https://git-scm.com/docs/git-commit#Documentation/git-commit.txt--o).
In all five cases, the effective index exposed to `pre-commit` through Git's
environment matched the resulting commit tree, but the gate's checks read
working-tree files independently of that index. An analysis of the original
index alone would therefore not close this boundary.

So the accurate statement of the invariant is:

> The gate always analyzes the **working tree**. It runs on `git commit`,
> and — since the issue #405 wiring — on `git push` for every pushed ref at
> that ref's commit state: in the checked-out working tree only under the
> provable-equality preconditions, otherwise in a temporary worktree checked
> out at the pushed commit. It also runs — since the issue #404 wiring —
> on every commit-creating porcelain with a wireable pre-creation hook:
> automatic conflict-free `git merge` and `git pull` (default merge mode)
> through `pre-merge-commit`, automatic conflict-free `git revert` and
> `git cherry-pick`, every replayed `git rebase` commit (including
> conflict-resolved `git rebase --continue`), the automatic rejoin/merge
> commits of `git subtree merge` / `pull` / `split --rejoin` /
> `push --rejoin`, and commit-side `--no-verify` on `git commit` /
> `git merge` (whose `prepare-commit-msg` still fires), all through
> `prepare-commit-msg`. The tree it passes is the tree
> actually recorded only when the analyzed contents match that tree: at
> commit time, they must match the **actual tree selected for that invocation**,
> after pathspecs and content-selection flags are applied. Matching the
> original index alone is insufficient: this excludes staged changes omitted
> by `--only` or a pathspec, unstaged tracked changes (including ones hidden
> by `skip-worktree` or `assume-unchanged`), and additional untracked or
> ignored inputs the gate reads. At push time (issue #405), the fast path
> takes the current working tree only when the pushed commit is `HEAD`, the
> index and working tree have no tracked differences from it, and no
> untracked non-ignored files sit in the trees the gate reads or the
> repository root — this is checked, not assumed. Ignored inputs and
> differences hidden by `skip-worktree` / `assume-unchanged` remain outside
> what git can prove (fast-path residuals recorded in
> [Push-Path Per-Ref Gating](#push-path-per-ref-gating-issue-405)); every
> other push is analyzed in a pristine temporary worktree of the pushed
> commit, which closes both.
> For automatic, conflict-free operations, it does **not** analyze:
> `git am`, `git stash` in any entry-creating form
> (`push`, shorthand, `save`, `-u`/`--all`; entry commits under
> `refs/stash`), `git stash create` (a ref-less stash commit object),
> `--autostash` on `merge`/`pull`/`rebase` (ref-less temporary stash
> commits; the merge/rebase commits they wrap are gated),
> `git notes` mutations (commits under `refs/notes/*`),
> `git commit-tree` (commit objects placed on history via `update-ref`),
> `git hash-object -t commit -w` (commit objects written directly, then
> installed via `update-ref` or pushed by OID),
> `git replace` in any form (ordinary `[-f] <object> <replacement>`,
> `--graft`, `--edit`, `--convert-graft-file`; replacement
> commits under `refs/replace/*`),
> `git fast-import` (`commit <ref>` stream commands), `git quiltimport`
> (quilt patchset commits), `git filter-branch`
> (rewritten history), `git lfs migrate` (extension history rewrite /
> no-rewrite commit; reviewer probe, see note), `git subtree split --branch` (rewritten commits under
> the requested branch), `git subtree split` without `--branch` (a ref-less
> split commit publishable by direct-OID push), the generated
> split commits of `subtree split --rejoin` / `push` / `push --rejoin` and
> the `git subtree add` merge commit, or the `--squash` variants' synthetic
> commits. For both `subtree push` forms, `pre-push` runs but scans the
> checked-out tree instead of the generated split tip. The
> `--squash` variants of `subtree add`, `merge`, `pull`, `split --rejoin`,
> and `push --rejoin` additionally create a ref-less synthetic squash commit
> that no local hook can gate. With `rebase --update-refs`, the replayed
> tips of other local branches move by `reference-transaction` alone and are
> not gated. `git push --no-verify` still bypasses the push-time
> `pre-push` rerun entirely (`git push -h` documents it as "bypass pre-push
> hook"); commit-side `--no-verify` runs the gate through the wired
> `prepare-commit-msg` since issue #404 (single-use marker; the editor-abort
> residue noted in the Decision section bounds the claim).

An earlier revision of this file claimed that no commit is ever created without
the full gate having run, and that the only shared hook for `revert` and
`cherry-pick` was `prepare-commit-msg` *and* `commit-msg`. Both claims were
false; review on PR #403 caught them. `commit-msg` never fires for those two
commands, which also means the `commit-msg`-based remedy that revision proposed
would not have closed the gap at all — see below.

Automatic conflict-free `revert` and `cherry-pick` commits have no
pre-commit-equivalent hook, and no `commit-msg` either. `prepare-commit-msg` is
their pre-creation message hook; the shared index-write callback above cannot
block the operation. The issue #404 wiring nevertheless selects
`prepare-commit-msg` as the gate point for exactly these paths: a measured
probe (git 2.48.1) confirmed its non-zero exit aborts `git revert` and
`git cherry-pick` before the commit exists, and the automated probe in
`scripts/gate-tree-marker.test.ts` pins that behavior. Because
`prepare-commit-msg` also fires for ordinary `git commit` and merge commits —
where `pre-commit` / `pre-merge-commit` have already gated the same index tree
— the tree marker (`scripts/gate-tree-marker.sh`) deduplicates: an ordinary
commit or merge still pays exactly one complete gate run, while
revert / cherry-pick / rebase replays (and `--no-verify` commits) find no
fresh matching marker and run the complete gate. The marker is consumed on a
successful check (评审 4120128545), so it serves exactly the operation that
wrote it and cannot be reused by a later same-tree operation; the fallback
gate run itself writes no marker (评审 4120239723) — two consecutive
same-tree `--no-verify` commits therefore each pay the complete gate. The earlier
record declined
to propose this remedy because closing the gaps "would change gate behavior",
which the #356 decision explicitly did not do; issue #404 is precisely the
follow-up decision that authorizes the behavior change, and this section now
records its outcome.

## Known Finding: Uncovered Commit-Creation Paths

**Update 2026-09-28 (issue #404 wiring)**: conflict-free `git merge`,
`git pull` (default merge mode), `git revert`, `git cherry-pick`, replayed
`git rebase` commits (including conflict-resolved `--continue`), the
automatic subtree merge/rejoin commits, and commit-side `--no-verify` are
**no longer uncovered** — they are gated through the wired
`pre-merge-commit` / `prepare-commit-msg` hooks with tree-marker dedup (see
[What The Gate Actually Enforces](#what-the-gate-actually-enforces)). The
original finding text below is retained for the paths that remain uncovered.

The uncovered automatic commit-producing paths and replacement-object paths —
`git am`,
`git commit-tree` plus `git update-ref`, `git hash-object -t commit -w`
plus `git update-ref` or direct-OID push, `git fast-import`,
`git quiltimport`, `git filter-branch`, `git lfs migrate` (extension;
reviewer probe, not measured here),
`git subtree split --branch`, `git subtree split` without `--branch` (a
ref-less split commit publishable by direct-OID push), the generated
split commits of `git subtree split --rejoin` and `git subtree push`
(with or without `--rejoin`), `git subtree add`,
`git stash create`, `--autostash` on `merge`/`pull`/`rebase` (the wrapped
merge/rebase commits are gated; the temporary stash objects are not), with
`rebase --update-refs` the replayed tips of other local branches, and
`git replace` in any form (ordinary, `--graft`, `--edit`,
`--convert-graft-file`) — can produce or replace commits without the gate
analyzing the resulting commit (评审
4115477920, 4115606416, 4115639629, 4115682292, 4115710587, 4115748220,
4115748226, 4115812068, 4115865920, 4115865924, 4117675224, 4117675234,
4117872584, 4117983619). The `--squash` variants of `subtree add`, `merge`, `pull`,
`split --rejoin`, and `push --rejoin` additionally create a ref-less
synthetic squash commit that no local hook can gate (评审 4117804224,
4117843430, 4117872586).
`git subtree push` does run `pre-push`, but that hook
scans the checked-out tree rather than its generated split tip. With
`--rejoin`, the generated split is also merged into the checked-out branch;
that merge is now gated by the wired `pre-merge-commit` (issue #404), while
the #405 pushed-tip mismatch stays intact. `git subtree add` is a
separate unchecked merge path with a `reference-transaction` callback, as
measured above (评审 4115748226). For
`split --rejoin`, only the rejoin merge updates the checked-out branch; in the
automatic conflict-free path, split commits are generated without commit
hooks while the rejoin is now gated. If the
rejoin conflicts and is continued through `git merge --continue`, `pre-commit`
runs for that merge while split generation remains ungated (评审 4115865920).
`git stash push` is not counted here because its commits stay under
`refs/stash`; `git stash create` is included because it produces a ref-less
object. The `reference-transaction` options for stash push and notes are
deliberately **not wired** by the issue #404 fix: that hook fires on every
ref update — including fetch, push remote-tracking updates, branch
create/delete, reset, and tag — so gating it with the complete gate would
tax routine non-committing ref operations, and aborting `prepared` states
can break ordinary workflows; the remote-facing exposure of stash/notes
objects is the [#405](https://github.com/hailingu/PlotWeave/issues/405)
push-side gap (push scans the checked-out tree). Revisit as an owner
decision if those paths see real use. Separately, `git push --no-verify`
bypasses the push-time `pre-push` rerun entirely (评审 4115110181,
4115477925). It does not undo an earlier `pre-commit` gate run: if the
commit was created through ordinary `git commit`, that gate already ran,
subject to the commit-tree/working-tree mismatch described above. A push with no
analysis of the pushed state is possible when no earlier gate analyzed
that state, for example after one of the uncovered creation paths. The
prohibition in `AGENTS.md` covers this push-time bypass regardless of any
earlier analysis.

Push-time analysis since the issue #405 fix (2026-09-30) covers every
pushed ref at that ref's own commit — a pristine temporary-worktree checkout
unless the current tree is provably identical to the pushed commit (see
[Push-Path Per-Ref Gating](#push-path-per-ref-gating-issue-405)). The
pre-fix wording is retained below as the record of what the narrow case
used to be: the fast path's residuals (tracked differences hidden by
`skip-worktree` or `assume-unchanged`, extra ignored inputs) are exactly
the parts of that wording git still cannot prove (评审 4115241706,
4115510915), and the slow path closes them.
Whether to wire `pre-merge-commit` was a governance decision with a real cost
attached (every merge became a gate run); it was out of scope for #356 and
has since been decided and implemented by
[#404](https://github.com/hailingu/PlotWeave/issues/404) (2026-09-28), which
wired `pre-merge-commit` and `prepare-commit-msg` with tree-marker dedup so
each commit-creating operation pays exactly one complete gate run.

## Known Finding: Push Scans The Checked-Out Tree, Not The Pushed Ref

**Update 2026-09-30 (issue #405 fix)**: this finding is closed. `.githooks/
pre-push` now reads the refs Git hands it on stdin and gates every pushed
ref at that ref's commit state — in the current working tree only when it is
provably identical to the pushed commit, otherwise in a temporary worktree
checked out at that commit (see
[Push-Path Per-Ref Gating](#push-path-per-ref-gating-issue-405)). The
equality proof covers tracked differences (staged and unstaged) and
untracked non-ignored files in the trees the gate reads plus the repository
root; ignored inputs and differences hidden by `skip-worktree` /
`assume-unchanged` remain outside what git can prove and are recorded as
fast-path residuals there — the slow path's pristine checkout closes both.
The founding text below is retained as the pre-fix measurement.

`.githooks/pre-push` reads no input. Git hands the hook the refs about to be
pushed on standard input; the hook ignores it and runs
`sonar-quality-gate.sh` against the current working tree. So when a developer
pushes a ref other than the checked-out branch — `git push origin other-branch`,
several refs at once, or `--all` — the gate analyzes and passes on the
**checked-out** tree, and the commit actually pushed may never have been
analyzed at all.

Branch identity is not sufficient either. The hook scans the **working tree**,
not the pushed commit, so a push can pass on state the pushed commit does
not contain. The first variant is uncommitted work: after committing state A
on the checked-out branch, an uncommitted change B means `git push` sends A
while the gate's tests and scanner inspect B, so the gate can pass on B and
A reaches the remote never analyzed. The second is ignored files: "clean"
does not exclude them, because `.git/info/exclude` (or any ignore rule)
hides a file from `git status` yet not from the gate. With `src/local.ts`
excluded and this repository's `tsconfig.json` including all of `src`, a
push of HEAD state A leaves `git status` clean while `pre-push` analyzes A
plus the ignored file B (评审 4115241706). Measured on git 2.48.1:
`git status --porcelain` was empty, the push sent only A, and the hook read
the ignored `src/local.ts`. So even a push that matches the checked-out
branch with no reported changes can analyze a tree the pushed commit does
not contain.

Tracked changes can also be invisible to `git status`: in isolated Git
2.48.1 probes, marking `src/local.ts` with `skip-worktree` or
`assume-unchanged` and then changing its contents left `git status
--porcelain` empty while the file differed from `HEAD` (评审 4115510915).
The working-tree version passed TypeScript checking while the committed
version failed it, with no ignored input involved. These flags have
[different documented purposes](https://git-scm.com/docs/git-update-index#_skip_worktree_bit);
neither makes clean status proof that the analyzed contents match the
pushed commit. The same hidden tracked difference can affect the
comparison with the selected commit tree at commit time.

The plumbing path also has a push-side variant with no local ref update:
`git push <remote> <oid>:refs/heads/…` sends a commit object that no local
ref points at, so no local `reference-transaction` fires and `pre-push`
again analyzes the unrelated checked-out tree (评审 4115241708). Measured on
git 2.48.1: such a push installed the object on the remote
(`refs/heads/direct`) while the local hook log shows only `pre-push` reading
the pushed OID from stdin and no `reference-transaction` entry. Only the
pushed-ref remedy below can close this one.

`git subtree push --prefix=<prefix> <repository> <refspec>` has the same
push-side mismatch, while also creating the commits it pushes. In a Git
2.48.1 two-commit fixture, the command created a rewritten split chain and
pushed its tip directly without updating the checked-out branch. `pre-push`
received the split-tip OID while `HEAD` remained the distinct full-project
commit scanned by the gate. A `reference-transaction` callback updated the
local remote-tracking ref only after the bare remote accepted the push, too
late to block it. The push-side mismatch is tracked in #405 and requires
analyzing the pushed split tip.

Adding `--rejoin` changes the local history transition but not the pushed-tip
identity. In a Git 2.48.1 fixture with new subtree content, `git subtree push
--rejoin` created a two-parent merge on the checked-out branch; its
`reference-transaction` callback covered `refs/heads/main` before the push,
and `pre-merge-commit` fired. Then `pre-push` received the generated split-tip
OID while `HEAD` was the different rejoin merge commit. The merge therefore
has a possible local #404 closure, but the current gate does not wire either
hook, and the #405 wrong-tree scan still applies to the pushed split commit
(评审 4115812068).

Verified on 2026-09-27 with a local bare remote and a hook that logs both the
stdin refs and `HEAD`:

```
stdin (ref actually pushed): refs/heads/other 384b7636aea2…
HEAD (what the gate scans):  7db139eda9f2… (main)
```

Because CI does not run SonarQube (see the Scope Routing row for `.github/**`),
the push-time gate is the only SonarQube path on the push side; the same
script also runs on `git commit`, so the covered creation path has an earlier
analysis, subject to the commit-tree/working-tree mismatch described above. If no
earlier gate analyzed the pushed state, pushing a different ref can let it
reach the remote without any SonarQube pass for that state. Using
`--no-verify` likewise skips the push-time gate; it does not erase any
earlier analysis. This is a separate problem from the commit-creation gaps
above, with a different
trigger and a different remedy, so it is tracked separately rather than folded
into #404: [#405](https://github.com/hailingu/PlotWeave/issues/405).
The commit-side counterpart — a commit analyzed on working-tree state it
does not contain (omitted staged changes, unstaged tracked changes, or
untracked/ignored inputs) — is recorded in
[What The Gate Actually Enforces](#what-the-gate-actually-enforces) as a
boundary of this inventory.

## Measured Baseline

Two measurements live here. The **founding baseline (2026-09-27)** is what
the decision above was taken against, as delivered by PR #403. The
**refreshed baseline (2026-09-30)** measures the complete gate as it exists
after the issue #404 commit-creation wiring, the issue #393 coverage floor,
and the issue #355 evidence record were added to it, and it runs on the Node
version pinned by `.nvmrc` (the founding run did not — see its caveats).
Compare future measurements against the refreshed baseline; the founding one
is retained because the decision and the alternatives analysis above were
argued on its numbers.

### Founding Baseline (2026-09-27)

Taken at commit `ba151ce` on `dev`, immediately after the
issue #363 merge, with warm build caches.

**Command** (run from the repository root `/Users/guhailin/Git/PlotWeave`):

```sh
/usr/bin/time -p sh scripts/sonar-quality-gate.sh
```

**Result**: exit 0 — `Quality Gate 已通过，新增代码未解决问题为 0`.

| Measurement | Value |
| --- | ---: |
| Wall clock, complete gate | **72.87s** |
| User CPU | 157.20s |
| System CPU | 22.64s |

#### Per-phase breakdown

Measured in the same working tree and environment, by timing each stage the
gate script runs in order.

| Phase | Wall clock | Share |
| --- | ---: | ---: |
| `scripts/check-static.sh` (format + lint + `typecheck:strict`) | 14.4s | 20% |
| `npm run test:coverage` (163 files / 2478 tests) | 15.8s | 22% |
| `scripts/rust-coverage.sh` (`cargo-llvm-cov`) | 16.6s | 23% |
| `sonar-scanner` + Quality Gate wait | ~26.1s | 35% |
| **Total** | **~72.9s** | **100%** |

The scanner figure is the remainder of the measured total after the three timed
stages, and is consistent with the scanner's own reported `Analysis total time:
24.919s` plus start-up.

**The distribution is the finding that matters here.** No single phase
dominates; the four are near-evenly split between 14s and 26s. Any proposal to
cut total cost has to address more than one phase, which is why option A alone
is bounded at 23%.

#### Commit frequency context

The repository has 1120 commits spanning 2026-08-21 to 2026-09-27 — 37 days.
That count includes 196 merge commits, of which 194 are GitHub PR merges
made remotely and 2 local — the former never invoked the local `pre-commit`
gate at all (评审 4115110183). Neither direction of the conversion from
retained history to hook invocations is sound, though: a failed commit
attempt can run the full hook without creating a commit, and commits later
amended, rebased, or dropped no longer appear in `rev-list`, so retained
history cannot lower- or upper-bound actual invocations (评审 4115135529).
The daily figures below are therefore **estimates from retained history,
uncertain in both directions**, not measured invocation rates: pre-commit
alone is roughly 30 minutes per day at the retained ~25 eligible commits/day
(194 remote PR merges excluded). The
push-inclusive figures make a further, explicit assumption — about one
`pre-push` invocation per eligible commit (评审 4115318779): batching several commits
into one push lowers it, retrying failed pushes raises it, and push
frequency is independent of retained history. Under that assumption the
total is roughly 61 minutes per day, and under option B about 37 minutes
per day. Treat all of these as order-of-magnitude context only — a real
comparison requires measuring hook invocations, not inferring them from
history.

#### Environment

| Component | Version |
| --- | --- |
| OS | macOS 26.6.2 (arm64), 16 cores / 64 GiB |
| Node.js | **v22.11.0** (see caveats) |
| npm | 10.9.0 |
| rustc | 1.95.0 (`59807616e`, pinned by `rust-toolchain.toml`) |
| `cargo-llvm-cov` | 0.9.0 |
| `sonar-scanner` CLI | 7.3.0.5189 |
| SonarQube server | 26.8.0.126808 |

#### Caveats On This Baseline

Read these before comparing any measurement against the founding 72.87s
figure; comparisons against the gate as it exists today should use the
[refreshed baseline](#refreshed-baseline-2026-09-30) and its caveats
instead.

1. **Warm caches.** `src-tauri/target/` and the vitest cache were already
   populated, so the Rust compile and test phases are at their incremental
   cost. A cold `target/` would be materially slower. 72.87s is therefore the
   *typical repeated* cost, not a worst case.
2. **Node version does not match the pin.** `.nvmrc` and `package.json`
   `engines` require Node >= 24.18.0, but the measuring shell ran Node
   v22.11.0. The `engines` field is advisory and nothing enforces it, so the
   gate passed on an unsupported Node. Two consequences: the absolute number is
   not exactly what a correctly-provisioned environment would produce, and the
   absence of enforcement is itself a finding. This is out of scope for #356 and
   is not fixed by it — raise it separately if the drift is unintended.
3. **Single sample, not a distribution.** One run per phase. A future comparison
   should take at least three runs and compare medians; do not treat a single
   sub-second difference as signal.
4. **Machine-local.** Absolute seconds do not transfer between machines. Compare
   ratios and per-phase shares, not the total.

### Refreshed Baseline (2026-09-30)

Taken **2026-09-30** at commit `44891fe` (the `dev` tip; measured on task
branch `docs/issue-356-refresh-gate-baseline` before any file was edited),
with warm build caches, using the Node version pinned by `.nvmrc`
(v24.18.0, resolving founding caveat 2 for this measurement). Three
complete runs were taken plus one run per phase.

**Command** (unchanged, run from the repository root
`/Users/guhailin/Git/PlotWeave`):

```sh
/usr/bin/time -p sh scripts/sonar-quality-gate.sh
```

**Result**: all three runs exit 0 — `Quality Gate 已通过，新增代码未解决问题为 0`.

| Measurement | Value |
| --- | ---: |
| Wall clock, complete gate — runs of 134.41s / 135.49s / 136.62s | **135.49s (median)** |
| User CPU / System CPU (median run) | 255.86s / 25.29s |

#### Per-phase breakdown

Timed separately after the three complete runs, in the order the gate script
runs them.

| Phase | Wall clock | Share |
| --- | ---: | ---: |
| `scripts/check-static.sh` (format + lint + `typecheck:strict`) | 12.8s | 9% |
| `npm run test:coverage` (169 files / 2536 tests) | 41.8s | 31% |
| `scripts/rust-coverage.sh` (`cargo-llvm-cov`; 527 tests across two targets) | 48.3s | 36% |
| `sonar-scanner` + Quality Gate wait (remainder; the scanner's own total was 27.2–28.4s across runs) | ~32.7s | 24% |
| **Total (median of three complete runs)** | **~135.5s** | **100%** |

**The even split is gone — that is the finding that matters here.** The
founding baseline's near-even four-way split no longer holds: the two
coverage phases together are ~67% of a run, and the Rust coverage phase is
the largest single phase at ~36% — approaching, but not passing, the ~40%
single-phase mark at which that phase becomes the optimization target.
Losing the even split is itself a fired
[Reconsideration Trigger](#reconsideration-triggers), and the revisit it
required is recorded in
[Status Of The Alternatives](#status-of-the-alternatives) (PR #441 评审
5360118900). Between the two measurements the
frontend coverage phase went 15.8s → 41.8s and the Rust coverage phase
16.6s → 48.3s, while the static phase got slightly faster (14.4s → 12.8s).
Frontend suite growth alone (2478 → 2536 tests, +2.3%) does not account for
the coverage-phase growth; this record does not attribute the remainder —
the two baselines differ in more than code (Node major 22 → 24 among them),
so compare shares, not deltas.

#### Commit frequency context

The repository now has 1246 commits spanning 2026-08-21 to 2026-09-30 — 40
days. That count includes 215 merge commits, of which 213 are GitHub PR
merges made remotely and 2 local — the former never invoked the local
`pre-commit` gate at all. The same uncertainty as the founding paragraph
applies: retained history cannot bound actual hook invocations in either
direction, so these remain **estimates from retained history, uncertain in
both directions**. Pre-commit alone is roughly 58 minutes per day at the
retained ~26 eligible commits/day (213 remote PR merges excluded). Under
the same one-`pre-push`-per-eligible-commit assumption (batching lowers it,
retries raise it), the total is roughly 117 minutes per day, and under
option B about 64 minutes per day. Treat all of these as order-of-magnitude
context only.

#### Environment

| Component | Version |
| --- | --- |
| OS | macOS 26.6.2 (arm64), 16 cores / 64 GiB (same machine as the founding run) |
| Node.js | **v24.18.0** — matches the `.nvmrc` / `engines` pin |
| npm | 11.16.0 |
| rustc | 1.95.0 (`59807616e`, pinned by `rust-toolchain.toml`) |
| `cargo-llvm-cov` | 0.9.0 |
| `sonar-scanner` CLI | 7.3.0.5189 |
| SonarQube server | 26.8.0.126808 |

#### Caveats On This Refresh

1. **Warm caches, consistent runs.** Same-machine warm caches as the
   founding run; the three complete runs sit within 2.2s of each other, so
   135.5s is the *typical repeated* cost, not a worst case. A cold
   `src-tauri/target/` would be materially slower.
2. **Node pin matches — for this measurement only.** Founding caveat 2 is
   resolved here by measuring on v24.18.0; the underlying finding that
   `engines` is advisory and nothing enforces the pin remains true, stays
   recorded there, and is not fixed by this change.
3. **Three samples on one day.** Better than the founding single sample,
   still not a distribution across days. Compare medians; do not treat
   sub-second differences as signal.
4. **Machine-local, and a Node-major gap versus the founding baseline.**
   Absolute seconds do not transfer between machines, and the founding run
   used Node 22 while this one uses the pinned Node 24. Compare ratios and
   per-phase shares across the two baselines, not wall-clock deltas.

### Push-Path Slow-Path Cost (2026-09-30, issue #405)

Measured once on landing the issue #405 fix (task branch
`fix/issue-405-pre-push-stdin-refs`, hook at the fix state), on the same
machine, Node version, and warm-toolchain caches as the refreshed baseline.
**Command** (per the re-measure recipe below): push a non-checked-out
commit (`44891fe`, the `dev` tip before PR #441) to a disposable local bare
remote, timing the whole push — worktree checkout, `npm ci`, and the
complete gate all sit inside it.

| Measurement | Value |
| --- | ---: |
| Wall clock, complete slow-path push (single sample) | **179.63s** |
| User CPU / System CPU | 348.59s / 47.08s |
| Fast-path comparison (refreshed baseline median, same machine) | 135.49s |

**Result**: exit 0 — `[pre-push] 门禁对象：44891fe（…，临时 worktree）`,
`Quality Gate 已通过，新增代码未解决问题为 0`, the remote received exactly
the pushed commit, the temporary worktree was removed, and the push's own
`materialize` folded the run's record (`head` `44891fe…`, `tree`
`a8651cd…` — equal to `git rev-parse 44891fe^{tree}`) into the versioned
`gate-history.jsonl`. That record equality is the acceptance probe for the
issue: the analyzed object is the pushed ref's commit, not the checked-out
tree.

Caveats: a single sample on one day; the first slow-path run on the machine
paid cold `src-tauri/target` and `node_modules` construction inside the
temporary worktree (the ~44s delta over the warm fast-path median understates
a fully cold machine and overstates a repeat slow path against a recently
built tree); dependencies resolved from the shared local npm/cargo caches.
The fast path is unaffected — it is the same complete-gate run the refreshed
baseline measures, with only the equality preconditions added ahead of it.

## Reconsideration Triggers

Revisit this decision — and re-measure before drawing conclusions — when any of
these becomes true:

- A phase's share stops being evenly split. This bullet carries two
  escalating levels (made explicit by PR #441 评审 5360118900): when the
  split stops being even, re-measure and revisit this decision against the
  fresh numbers, recording the outcome; when one phase additionally grows
  past roughly 40% of the total, that phase becomes the thing to optimize,
  and option A (or an equivalent) deserves a real design. Status as of the
  2026-09-30 refresh: the even split is gone — the Rust coverage phase is
  ~36% and the two coverage phases are ~67% combined — so the first level
  has fired and its revisit was performed in the same change (three-run
  median; outcome recorded in
  [Status Of The Alternatives](#status-of-the-alternatives): the decline
  stands). No single phase has passed the ~40% mark, so the option-A
  design level has not fired. It is near; re-measure before drawing any
  conclusion from a share crossing it.
- The commit rate rises materially above the ~25/day this baseline assumes, or
  the gate is reported as a recurring source of blocked or abandoned work. The
  argument for accepting a fixed cost weakens with frequency. Because option B
  removes the coverage and scanner phases from the per-commit path, it scales
  with commit count in a way option A does not — a rising commit rate is the
  strongest argument for reopening B.
- CI gains the ability to run SonarQube, which would move the cost off the
  local critical path entirely. That changes the premise — the issue notes the
  cost cannot be unloaded to CI today precisely because CI does not carry Sonar.
- Any option A or B proposal appears: it must come with a fresh baseline and an
  explicit statement of its effect on gate strength, and must preserve every
  invariant in the section above.
- The uncovered commit-creation paths are closed, or an `am`, `stash` (all
  forms: `push`, shorthand, `save`, `-u`/`--all`, `create`), `notes`,
  `commit-tree`, `replace`, `fast-import`, `quiltimport`, `filter-branch`,
  `lfs migrate` (and other history-rewriting extensions such as
  `filter-repo` / `git-annex`), or `subtree add/split/push`
  workflow (including `split --rejoin` and `push --rejoin`) path changes to
  route through `git commit` or gains a wired hook. (`merge`, `revert`,
  `cherry-pick`, `rebase` replays, and the subtree merge/rejoin commits were
  closed by the issue #404 wiring on 2026-09-28.) Either way,
  update
  [What The Gate Actually Enforces](#what-the-gate-actually-enforces) in the same
  change — that table is a measurement, and a stale one is worse than none.
- `pre-push` starts reading its stdin **and the gate analyzes the pushed
  commit** (for example by checking out the pushed ref into a temporary
  worktree for the scan) instead of the current working tree. Reading stdin
  alone identifies the pushed ref but does not close the dirty-worktree
  mismatch recorded above — with uncommitted change B on the checked-out
  branch, the scanner would still inspect B while A is what was pushed. That
  is a gate-strength change, not a cost change, and needs its own decision —
  but until it happens, every enforcement statement in this file is
  conditional on the pushed ref being the checked-out branch **and the
  analyzed working-tree contents actually matching the pushed commit**:
  no tracked differences, including index-hidden ones, and no extra
  untracked or ignored inputs the gate reads. Git-clean status alone does
  not establish this equality (评审 4115477929, 4115510915).
  Status: fired and resolved 2026-09-30 by the issue #405 fix — the gate
  decision it demanded is [#405](https://github.com/hailingu/PlotWeave/issues/405),
  implemented as the per-ref push gating this file now records (see
  [Push-Path Per-Ref Gating](#push-path-per-ref-gating-issue-405)): stdin is
  read, every pushed commit is analyzed at its own state, and the
  dirty-worktree mismatch falls to the slow-path temporary worktree rather
  than being assumed away.
- The gate starts analyzing the prospective commit tree selected by Git for
  that invocation, respecting pathspecs and content-selection flags, instead
  of the working tree. Scanning the original index alone is insufficient for
  `--only` or pathspec commits. Until then, the `git commit` rows' "yes" mean
  the gate runs when the commit is created, not that the committed tree was
  the state analyzed.

## How To Re-measure

Run from the repository root with `SONAR_HOST_URL` set and a token available as
`SONAR_TOKEN` or `PLOTWEAVE_SONAR_TOKEN`, on the Node version pinned by
`.nvmrc` (the founding baseline's Node-drift caveat is the reason):

```sh
/usr/bin/time -p sh scripts/sonar-quality-gate.sh
```

Take at least three complete runs and compare medians — a single run is not
a distribution (the founding caveat 3 / refresh caveat 3).

For the per-phase split, time the three non-scanner stages individually in the
order the gate script runs them, and take the remainder as the scanner phase:

```sh
time sh scripts/check-static.sh
time npm run test:coverage
time sh scripts/rust-coverage.sh
```

For the push-path slow path (issue #405), push a non-checked-out commit to a
disposable local bare remote and time the whole push — the hook's worktree
checkout, `npm ci`, and complete gate all sit inside it:

```sh
git init --bare -q "$(mktemp -d)/origin.git"   # 把输出路径用于下行
/usr/bin/time -p git push <那个路径>/origin.git <旧提交>:refs/heads/probe-side
```

Expect the first slow-path run on a machine to pay cold dependency caches
(the sample below did); a repeat slow path against a recently built tree is
faster.

Record the commit under measurement and the environment table above alongside
the result, so two measurements stay comparable.
