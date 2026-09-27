# Quality Gate Cost Decision

**Applies to**: the versioned local Git hooks (`.githooks/pre-commit`,
`.githooks/pre-push`) and `scripts/sonar-quality-gate.sh`. Like the root
`AGENTS.md` and the other standards under `docs/development/`, this file is
written in English for agent interoperability.

**Last reviewed**: 2026-09-27

**Status**: Active — accepted decision. Recorded 2026-09-27, resolving
[issue #356](https://github.com/hailingu/PlotWeave/issues/356).

## Required Reading

- [AGENTS.md](../../AGENTS.md) — the Non-Negotiable Gates and
  Version-Control Safety sections. This file records *one* decision about that
  gate; it never relaxes it.
- [Software Engineering Standard](software-engineering-standard.md) — the
  repository-wide baseline for change design and documented exceptions.

## Decision

**The gate stays a single, uniform cost. There is no fast lane.**

`git commit` and `git push` each run the same complete sequence:

1. `scripts/check-static.sh` — Prettier format check, ESLint with zero
   warnings, `typecheck:strict`. Fail-fast, ahead of all coverage work.
2. `npm run test:coverage` — the full frontend suite, serialized to LCOV.
3. `scripts/rust-coverage.sh` — `cargo-llvm-cov` over the library and the
   `media_format_leaf` test target.
4. `sonar-scanner` publishing the analysis, then waiting for the Quality Gate,
   then a separate check that new-code unresolved issues are zero.

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
~30 commits/day below that is about 29 minutes per day, a ~40% reduction in
total gate time.

A review of this record caught exactly that mislabelling; the figure above is
the corrected one. Note that option B would *not* weaken the gate's coverage —
`check-static.sh` still runs on every `git commit`, and SonarQube analysis plus
the Quality Gate still run before anything reaches the remote. Within the scope
the gate actually covers (see
[What The Gate Actually Enforces](#what-the-gate-actually-enforces)), what option
B changes is that a commit can be created locally before the coverage and
scanner phases have run for it.

Declining A and B is a statement about today's numbers, not a permanent
refusal. See [Reconsideration Triggers](#reconsideration-triggers).

## Impact On Gate Strength

**None. This decision changes no gate behavior at all.** It is a documentation
and measurement change only. The following remain in force exactly as written in
`AGENTS.md`, and nothing in this file is an exception to them:

- Both hooks stay enabled and both run the complete `sonar-quality-gate.sh`.
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
`PLOTWEAVE_CARGO_LLVM_COV_BIN`, and the report-path overrides
(`PLOTWEAVE_COVERAGE_REPORT_PATH`, `PLOTWEAVE_RUST_COVERAGE_REPORT_PATH`,
`PLOTWEAVE_SONAR_REPORT_PATH`) as **test-only injection points**, and the
hooks `exec` the gate script so those variables are inherited (评审
4115318775). A shell that exports them can point the gate at substitute
executables or pre-written reports and thereby skip real checks. These
overrides exist for the gate's own test suite; using them to bypass the
gate is the same class of explicit evasion as `--no-verify`, which
`AGENTS.md` prohibits. Closing the injection points in hook invocations is
a hardening change to gate behavior and out of scope for this record.

Anyone reading a faster local workflow elsewhere in this repository should
treat it as a defect in that workflow, not as sanctioned by this decision.

## What The Gate Actually Enforces

The bullets above describe intent. This section records the verified
*enforcement* boundary, so that no reader overstates the guarantee. It was
measured on 2026-09-27 against git 2.48.1 with `core.hooksPath` set to a
directory containing every candidate hook, recording which ones fire.

This repository wires exactly two: `.githooks/pre-commit` and
`.githooks/pre-push`. There is no `pre-merge-commit`, `commit-msg`,
`prepare-commit-msg`, `post-commit`, `post-merge`, `pre-rebase`,
`post-rewrite`, `pre-applypatch`, `applypatch-msg`, or
`reference-transaction`.

| Command that creates a commit | Hooks that actually fire | Gate runs? |
| --- | --- | :---: |
| `git commit` | `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit` | yes |
| `git merge` producing a merge commit (non-fast-forward) | `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-merge` | **no** |
| `git revert` (automatic commit) | `prepare-commit-msg` + `post-commit` | **no** |
| `git cherry-pick` (automatic commit) | `prepare-commit-msg` + `post-commit` | **no** |
| `git rebase` replaying commits onto a new base | `pre-rebase` once, then `prepare-commit-msg` + `post-commit` per replayed commit, `post-rewrite` once at the end | **no** |
| `git am` applying a patch series | `applypatch-msg`, `pre-applypatch`, `post-applypatch` — none wired | **no** |
| `git stash push` (tracked changes) | `reference-transaction` only — no commit-creation hooks | **no** * |
| `git notes add` / `append` / `edit` | `reference-transaction` only — no commit-creation hooks | **no** * |
| `git commit-tree` + `git update-ref` (plumbing) | `reference-transaction` only — no commit-creation hooks | **no** * |
| `git fast-import` (`commit <ref>` stream) | `reference-transaction` only — no commit-creation hooks | **no** * |
| `git filter-branch` (history rewrite) | none — no hooks at all | **no** * |
| `git merge --squash` / `--no-commit` followed by `git commit` | `pre-commit`, … | yes |
| `git commit --no-verify` / `git merge --no-verify` | `prepare-commit-msg` + `post-commit` / `post-merge` respectively | **no** |

\* These rows produce commits under refs that are **pushable by explicit
refspec** — `git push <remote> refs/stash:refs/heads/…`, `refs/notes/*`,
or the branch `update-ref` just created — so each carries the same
remote-facing gap tracked in
[Known Finding: Push Scans The Checked-Out Tree, Not The Pushed
Ref](#known-finding-push-scans-the-checked-out-tree-not-the-pushed-ref):
`pre-push` analyzes the checked-out tree, not the pushed ref (评审
4115165662, 4115165667). The `commit-tree` row additionally has a
direct-OID push variant that no local hook can gate at all; see the
commit-tree paragraph below.

Every command in this table also fires `reference-transaction` on the ref
updates it performs — measured on git 2.48.1 for `git commit`
(`refs/heads/*`), `git merge`, `git cherry-pick`, and `git stash push`
(`refs/stash`) — and the per-row hook lists omit it because it is not
commit-creation-specific (评审 4114992022). This repository does not wire it,
so the Gate column is unaffected. Note that a nonzero exit in its `prepared`
state aborts the ref update, which makes it the one hook type that could in
principle gate these paths; whether to do so is a #404 hook-design question,
not part of this decision.

`git revert` and `git cherry-pick` do not accept `--no-verify` at all
(`git revert -h` / `git cherry-pick -h` list no such option), so they are
absent from the last row rather than bypassable through it. Their automatic
commits run `prepare-commit-msg` and `post-commit` — **not** `commit-msg`, which
`githooks(5)` documents as applying to `git commit` and `git merge`
(评审 4114854376). Like the rebase row, `post-commit` fires only once the commit
exists and git ignores its exit status, so it cannot implement a blocking gate
either. `post-merge` on the merge rows is likewise after the fact: it fires
after the merge has completed and cannot block it.

`git rebase` and `git am` were measured on 2026-09-27 (git 2.48.1, isolated
hook log, two commits replayed / one patch applied) with this repository's
wiring absent, so the rows above record which hooks *would* fire: a
commit-producing rebase runs `pre-rebase` once and then `prepare-commit-msg`
and `post-commit` per replayed commit — **`pre-commit` and `commit-msg` never
fire** — and `post-rewrite` once after the replay, whose exit status git
ignores, so it cannot implement a blocking gate either (评审 4114827177);
`git am` runs only the applypatch-family hooks, none of which
this repository wires. Either path therefore creates commits with no gate.

`git stash push` with tracked changes creates its entry commits under
`refs/stash` — the stash commit plus its index parent — without running any
commit-creation hook (评审 4114895001); the `git-stash` documentation likewise
describes a stash entry as a commit. Stashed work normally re-enters the tree
through `git stash pop` / `apply`, which create no commits, and becomes
commits only through the paths this table already records. Its one hook is
`reference-transaction` on the `refs/stash` update, and aborting that update
in the `prepared` state does prevent the entry — measured: with such a hook
`git stash push` fails with exit 128 ("ref updates aborted by hook") and
`refs/stash` keeps its previous value — though the entry's objects are
already written by then (评审 4114992022). Stash therefore remains within
#404's hook-design scope rather than being excluded as unwireable.

The stash commits are also pushable: an explicit refspec such as
`git push <remote> refs/stash:refs/heads/…`, or `--mirror`, copies the stash
commit to the remote while `pre-push` analyzes the unrelated checked-out
tree (评审 4115165662) — measured on git 2.48.1, `git push <remote>
refs/stash:refs/heads/stashed` created a new remote branch holding the exact
stash commit. So stash does not, after all, stay purely local; its push-side
exposure is the push finding below, tracked there rather than re-counted
here.

`git notes add` / `append` / `edit` likewise create commits under
`refs/notes/*` (by default `refs/notes/commits`) without any
commit-creation hook — measured on git 2.48.1, only `reference-transaction`
fires (评审 4115135524). Notes refs are pushable (`git push origin
refs/notes/*`), so this row is remote-facing in the same sense the push
finding is; it is recorded here as a boundary and its closure —
`reference-transaction` in `prepared` state — is the same #404 option noted
for stash, not a separate remedy.

The plumbing path is uncovered too: `git commit-tree <tree>` creates a
commit object directly, and `git update-ref refs/heads/<branch> <commit>`
places it on branch history, without any commit-creation hook — measured on
git 2.48.1, only `reference-transaction` fired during the ref update
(评审 4115165667). This is the lowest-level way to land a commit with no gate,
and like the other off-hook paths its local ref-update closure is the same
#404 `reference-transaction` question. `git fast-import` reaches the same
place from a stream: its `commit <ref>` command creates the commit and
updates the branch in one step — measured on git 2.48.1, importing one
commit into `refs/heads/imported` fired only `reference-transaction`
(prepared + committed, twice) and no commit-creation hook (评审 4115220196).
Because this repository does not wire that hook, such an import bypasses the
gate on the commit side entirely. `git filter-branch` is the one measured
path with **no hooks at all**: rewriting two commits produced an empty hook
log — no commit-creation hook and not even `reference-transaction`
(评审 4115318769). It is recorded here as a boundary with no hook-side
closure; its result commits still reach the remote only through the push
paths this file already covers.

`reference-transaction` does **not** close every `commit-tree` path,
though: `update-ref` is optional. A commit object can be pushed directly by
OID — `git push <remote> <oid>:refs/heads/…` — while no local ref ever
points at it, so no local `reference-transaction` fires; `pre-push` runs
but analyzes the unrelated checked-out tree (评审 4115241708). Measured on
git 2.48.1: such a push installed the object on the remote
(`refs/heads/direct`) while the local hook log shows only `pre-push`
reading the pushed OID from stdin and no `reference-transaction` entry. The
plumbing path therefore splits: the local-ref variant is a #404
`reference-transaction` question; the direct-OID variant is a push-side gap
that only the #405 remedy (analyze the pushed ref) can close.

One qualification applies to the `git commit` row itself: the gate script
always scans the working tree, while the created commit contains the index.
Working-tree state beyond the index is therefore analyzed but never
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

So the accurate statement of the invariant is:

> The gate always analyzes the **working tree**. It runs on `git commit` and
> on `git push` of the checked-out branch, and the tree it passes is the tree
> actually recorded only when the working tree matches that tree: at commit
> time, nothing beyond the index — no unstaged tracked changes and no
> untracked files at all, including ones excluded by ignore rules such as
> `.git/info/exclude` (untracked and ignored files never enter the commit
> but are still scanned); at push time, the pushed ref is the checked-out
> branch **and the working tree is clean with no ignored inputs the gate
> reads** (an ignored file can otherwise be analyzed without being pushed).
> It does **not** run for commits produced
> automatically by `git merge`, `git revert`, `git cherry-pick`, `git rebase`
> (replayed commits), `git am`, `git stash push` (entry commits under
> `refs/stash`), `git notes` mutations (commits under `refs/notes/*`),
> `git commit-tree` (commit objects placed on history via `update-ref`),
> `git fast-import` (`commit <ref>` stream commands), or `git
> filter-branch` (rewritten history), and it can be skipped outright with
> `--no-verify` on
> `git commit`, `git merge`, and `git push` (which bypasses `pre-push`;
> `git push -h` documents it as "bypass pre-push hook").

An earlier revision of this file claimed that no commit is ever created without
the full gate having run, and that the only shared hook for `revert` and
`cherry-pick` was `prepare-commit-msg` *and* `commit-msg`. Both claims were
false; review on PR #403 caught them. `commit-msg` never fires for those two
commands, which also means the `commit-msg`-based remedy that revision proposed
would not have closed the gap at all — see below.

`revert` and `cherry-pick` have no pre-commit-equivalent hook, and no
`commit-msg` either. `prepare-commit-msg` is the only hook they run before the
commit exists, and it receives the commit message at that point, which is why
it is not a suitable place to run a gate; their one other hook, `post-commit`,
runs only after the commit exists and cannot block it, as recorded above.
Closing this gap is a hook-design decision rather
than a one-line addition, and no remedy is proposed here. It is recorded as a
finding below and is deliberately **not** fixed here: doing so would change gate
behavior, which this decision explicitly does not do.

## Known Finding: Uncovered Commit-Creation Paths

The five uncovered paths above mean a local merge, revert, cherry-pick, rebase,
or am can land commits on a branch with no static checks, no coverage, and no
SonarQube analysis for the resulting commit. The stash row is not counted
here: its commits stay under `refs/stash`, off branch history; the
`reference-transaction` option noted with that row is a #404 question, not a
branch-history gap (see the table); the notes row shares that same
disposition. Separately, `git push --no-verify`
bypasses `pre-push` entirely (评审 4115110181): even a clean push of the
checked-out branch then reaches the remote with no gate at all — a
remote-facing variant of the documented `--no-verify` bypass that the
prohibition in `AGENTS.md` covers but this section's bypass list had
omitted.

Push-time analysis is a *partial* safety net, and only in the common case: when
the pushed ref is the checked-out branch **and the working tree is clean**, the
`pre-push` gate analyzes the checked-out tree, which is the state being pushed.
For any other ref it does not — see
[Known Finding: Push Scans The Checked-Out Tree, Not The Pushed
Ref](#known-finding-push-scans-the-checked-out-tree-not-the-pushed-ref).
Whether to wire `pre-merge-commit` is a governance decision with a real cost
attached (every merge would become a gate run), and it is out of scope for
#356. Tracked as [#404](https://github.com/hailingu/PlotWeave/issues/404).

## Known Finding: Push Scans The Checked-Out Tree, Not The Pushed Ref

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

The plumbing path also has a push-side variant with no local hook at all:
`git push <remote> <oid>:refs/heads/…` sends a commit object that no local
ref points at, so no local `reference-transaction` fires and `pre-push`
again analyzes the unrelated checked-out tree (评审 4115241708). Measured on
git 2.48.1: such a push installed the object on the remote
(`refs/heads/direct`) while the local hook log shows only `pre-push` reading
the pushed OID from stdin and no `reference-transaction` entry. Only the
pushed-ref remedy below can close this one.

Verified on 2026-09-27 with a local bare remote and a hook that logs both the
stdin refs and `HEAD`:

```
stdin (ref actually pushed): refs/heads/other 384b7636aea2…
HEAD (what the gate scans):  7db139eda9f2… (main)
```

Because CI does not run SonarQube (see the Scope Routing row for `.github/**`),
the push-time gate is the only SonarQube path in this repository. A ref pushed
this way can reach the remote without any SonarQube pass for that state — and
so can any ref pushed with `--no-verify`, which bypasses `pre-push` outright. This
is a separate problem from the commit-creation gaps above, with a different
trigger and a different remedy, so it is tracked separately rather than folded
into #404: [#405](https://github.com/hailingu/PlotWeave/issues/405).
The commit-side counterpart — a commit analyzed on working-tree state it
does not contain (unstaged, untracked, or ignored) — is recorded in
[What The Gate Actually Enforces](#what-the-gate-actually-enforces) as a
boundary of this inventory.

## Measured Baseline

Taken **2026-09-27** at commit `ba151ce` on `dev`, immediately after the
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

### Per-phase breakdown

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

### Commit frequency context

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
alone is roughly 36 minutes per day at the retained ~30 commits/day. The
push-inclusive figures make a further, explicit assumption — about one
`pre-push` invocation per commit (评审 4115318779): batching several commits
into one push lowers it, retrying failed pushes raises it, and push
frequency is independent of retained history. Under that assumption the
total is roughly 73 minutes per day, and under option B about 44 minutes
per day. Treat all of these as order-of-magnitude context only — a real
comparison requires measuring hook invocations, not inferring them from
history.

### Environment

| Component | Version |
| --- | --- |
| OS | macOS 26.6.2 (arm64), 16 cores / 64 GiB |
| Node.js | **v22.11.0** (see caveats) |
| npm | 10.9.0 |
| rustc | 1.95.0 (`59807616e`, pinned by `rust-toolchain.toml`) |
| `cargo-llvm-cov` | 0.9.0 |
| `sonar-scanner` CLI | 7.3.0.5189 |
| SonarQube server | 26.8.0.126808 |

### Caveats On This Baseline

Read these before comparing any future measurement against 72.87s.

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

## Reconsideration Triggers

Revisit this decision — and re-measure before drawing conclusions — when any of
these becomes true:

- A phase's share stops being evenly split. If one phase grows past roughly 40%
  of the total, that phase becomes the thing to optimize, and option A (or an
  equivalent) deserves a real design.
- The commit rate rises materially above the ~30/day this baseline assumes, or
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
- The uncovered commit-creation paths are closed, or the
  merge/revert/cherry-pick/rebase/am/stash/notes/commit-tree/fast-import/
  filter-branch workflow changes to route through `git commit`. Either way,
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
  conditional on the pushed ref being the checked-out branch **with a clean
  working tree**.
- The gate starts analyzing the committed tree itself at commit time (for
  example by scanning a checkout of the index) instead of the working tree.
  Until then, the `git commit` row's "yes" means the gate runs when the
  commit is created, not that the committed tree was the state analyzed.

## How To Re-measure

Run from the repository root with `SONAR_HOST_URL` set and a token available as
`SONAR_TOKEN` or `PLOTWEAVE_SONAR_TOKEN`:

```sh
/usr/bin/time -p sh scripts/sonar-quality-gate.sh
```

For the per-phase split, time the three non-scanner stages individually in the
order the gate script runs them, and take the remainder as the scanner phase:

```sh
time sh scripts/check-static.sh
time npm run test:coverage
time sh scripts/rust-coverage.sh
```

Record the commit under measurement and the environment table above alongside
the result, so two measurements stay comparable.
