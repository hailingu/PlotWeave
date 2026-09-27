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

Anyone reading a faster local workflow elsewhere in this repository should treat
it as a defect in that workflow, not as sanctioned by this decision.

## What The Gate Actually Enforces

The bullets above describe intent. This section records the verified
*enforcement* boundary, so that no reader overstates the guarantee. It was
measured on 2026-09-27 against git 2.48.1 with `core.hooksPath` set to a
directory containing every candidate hook, recording which ones fire.

This repository wires exactly two: `.githooks/pre-commit` and
`.githooks/pre-push`. There is no `pre-merge-commit`, `commit-msg`,
`prepare-commit-msg`, `post-commit`, or `post-merge`.

| Command that creates a commit | Hooks that actually fire | Gate runs? |
| --- | --- | :---: |
| `git commit` | `pre-commit`, `prepare-commit-msg`, `commit-msg` | yes |
| `git merge` producing a merge commit (non-fast-forward) | `pre-merge-commit`, `prepare-commit-msg`, `commit-msg` | **no** |
| `git revert` (automatic commit) | `prepare-commit-msg` only | **no** |
| `git cherry-pick` (automatic commit) | `prepare-commit-msg` only | **no** |
| `git merge --squash` / `--no-commit` followed by `git commit` | `pre-commit`, … | yes |
| `git commit --no-verify` / `git merge --no-verify` | `prepare-commit-msg`, `commit-msg` | **no** |

`git revert` and `git cherry-pick` do not accept `--no-verify` at all
(`git revert -h` / `git cherry-pick -h` list no such option), so they are
absent from the last row rather than bypassable through it. Their automatic
commits run `prepare-commit-msg` and nothing else — **not** `commit-msg`, which
`githooks(5)` documents as applying to `git commit` and `git merge`.

So the accurate statement of the invariant is:

> The gate runs on `git commit` and on `git push` of the checked-out branch. It
> does **not** run for commits produced automatically by `git merge`,
> `git revert`, or `git cherry-pick`, and it can be skipped outright with
> `--no-verify` on `git commit` and `git merge`.

An earlier revision of this file claimed that no commit is ever created without
the full gate having run, and that the only shared hook for `revert` and
`cherry-pick` was `prepare-commit-msg` *and* `commit-msg`. Both claims were
false; review on PR #403 caught them. `commit-msg` never fires for those two
commands, which also means the `commit-msg`-based remedy that revision proposed
would not have closed the gap at all — see below.

`revert` and `cherry-pick` have no pre-commit-equivalent hook, and no
`commit-msg` either. `prepare-commit-msg` is the only hook they run, and it
receives the commit message before the commit exists, which is why it is not a
suitable place to run a gate. Closing this gap is a hook-design decision rather
than a one-line addition, and no remedy is proposed here. It is recorded as a
finding below and is deliberately **not** fixed here: doing so would change gate
behavior, which this decision explicitly does not do.

## Known Finding: Uncovered Commit-Creation Paths

The three uncovered paths above mean a local merge, revert, or cherry-pick can
land on a branch with no static checks, no coverage, and no SonarQube analysis
for the resulting commit.

Push-time analysis is a *partial* safety net, and only in the common case: when
the pushed ref is the checked-out branch, the `pre-push` gate does analyze the
commit that is being pushed. For any other ref it does not — see
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

Verified on 2026-09-27 with a local bare remote and a hook that logs both the
stdin refs and `HEAD`:

```
stdin (ref actually pushed): refs/heads/other 384b7636aea2…
HEAD (what the gate scans):  7db139eda9f2… (main)
```

Because CI does not run SonarQube (see the Scope Routing row for `.github/**`),
the push-time gate is the only SonarQube path in this repository. A ref pushed
this way can reach the remote without any SonarQube pass for that state. This
is a separate problem from the commit-creation gaps above, with a different
trigger and a different remedy, so it is tracked separately rather than folded
into #404: [#405](https://github.com/hailingu/PlotWeave/issues/405).

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

The repository has 1120 commits spanning 2026-08-21 to 2026-09-27 — 37 days at
roughly 30 commits per day. At 72.87s per run, the pre-commit hook alone costs
about 36 minutes per day. If each of those commits is also pushed, the
pre-commit and pre-push runs together cost roughly 73 minutes per day. Under
option B that total would fall to about 44 minutes per day. Treat these as
order-of-magnitude context, not measured figures — actual push frequency varies
with batching.

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
- The uncovered commit-creation paths are closed, or the merge/revert/cherry-pick
  workflow changes to route through `git commit`. Either way, update
  [What The Gate Actually Enforces](#what-the-gate-actually-enforces) in the same
  change — that table is a measurement, and a stale one is worse than none.
- `pre-push` starts reading its stdin so the analyzed ref matches the pushed
  ref. That is a gate-strength change, not a cost change, and needs its own
  decision — but until it happens, every enforcement statement in this file is
  conditional on the pushed ref being the checked-out branch.

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
