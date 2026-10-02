# Quality Gate Cost Decision

**Applies to**: the versioned local Git hooks (`.githooks/pre-commit`,
`.githooks/pre-merge-commit`, `.githooks/prepare-commit-msg`,
`.githooks/pre-push`), `scripts/sonar-quality-gate.sh`, and the gate-run
dedup marker helper `scripts/gate-tree-marker.sh` (issue #404). Like the root
`AGENTS.md` and the other standards under `docs/development/`, this file is
written in English for agent interoperability.

**Last reviewed**: 2026-10-02

**Status**: Active — accepted decision. Recorded 2026-09-27, resolving
[issue #356](https://github.com/hailingu/PlotWeave/issues/356); extended
2026-09-28 by the issue #404 commit-creation wiring (same complete gate,
more commands routed through it — see
[What The Gate Actually Enforces](quality-gate-enforcement.md#what-the-gate-actually-enforces)) and by
the issue #355 evidence record (one summary line per fully passing run,
written to a pending file inside `.git` and materialized into the versioned
file after a passing push — see
[Gate Run Evidence Record](quality-gate-evidence.md#gate-run-evidence-record-issue-355)); baseline
refreshed 2026-09-30 on the pinned Node toolchain, measuring the complete
gate as extended — that refresh fired the first distribution
reconsideration trigger, and the revisit it requires is recorded with the
alternatives (see [Measured Baseline](#measured-baseline) and
[Status Of The Alternatives](#status-of-the-alternatives)); and extended
2026-09-30 by the issue #405 push-path per-ref gating — a deliberate
gate-strength change authorized by that issue: `pre-push` now reads the refs
Git hands it on stdin and analyzes every pushed commit at its own state,
with a measured slow-path cost recorded alongside the baseline (see
[Push-Path Per-Ref Gating](quality-gate-push.md#push-path-per-ref-gating-issue-405) and
[Push-Path Slow-Path Cost](#push-path-slow-path-cost-2026-09-30-issue-405));
extended 2026-10-01 by the
[issue #429](https://github.com/hailingu/PlotWeave/issues/429) marker identity
fix, preventing reuse of aborted operations' residue by later Git processes;
clarified 2026-10-01 for
[issue #431](https://github.com/hailingu/PlotWeave/issues/431): the gate ledger
preserves self-reported conclusions with partial coverage, without independent
proof of execution (see [Gate Run Evidence Record](quality-gate-evidence.md#gate-run-evidence-record-issue-355));
clarified 2026-10-02 for
[issue #463](https://github.com/hailingu/PlotWeave/issues/463): the push-path
cost comparison now carries the fast path's reachability caveat — the
post-push ledger materialization and ordinary untracked files make the slow
path the practical default — with preconditions, causality, and recovery
conditions maintained in the push-gating topic doc (see
[快路径可达性与恢复条件](quality-gate-push.md#快路径可达性与恢复条件issue-463)).

## Required Reading

- [AGENTS.md](../../AGENTS.md) — the Non-Negotiable Gates and
  Version-Control Safety sections. This file records *one* decision about that
  gate; it never relaxes it.
- [Software Engineering Standard](software-engineering-standard.md) — the
  repository-wide baseline for change design and documented exceptions.

## 文档组织约定（issue #472）

本记录采用[issue #472](https://github.com/hailingu/PlotWeave/issues/472)的选项 A：
决策与证据分离。正文只维护决策、替代方案及门禁强度影响、实测成本基线、
重新评估触发条件、复测方法和导航；状态矩阵、命令清单、诊断契约与历史探针
按下表归属维护。此组织约定不改变任何门禁步骤、覆盖率要求或保留边界。

| 内容 | 唯一维护位置 |
| --- | --- |
| 成本决策、两次基线、慢路径成本、触发条件及复测方法 | 本文对应既有章节 |
| 标记归属与去重、测试隔离、共享锁恢复、测试注入边界 | [门禁生命周期](quality-gate-lifecycle.md) |
| 逐 ref 分派、回归矩阵、残余边界、推送对象错配的历史证据 | [推送门禁](quality-gate-push.md) |
| 台账字段、可信度边界、记录物化、可复现的查询方法 | [门禁运行证据](quality-gate-evidence.md) |
| 完整命令覆盖清单、逐命令实测说明、未覆盖提交创建路径 | [门禁覆盖边界](quality-gate-enforcement.md) |

新增 issue 应更新对应主题的既有章节；不得在决策正文按 issue 追加矩阵、
逐命令探针或证据清单。成本决策、门禁强度说明、基线或重新评估结论发生变化时，
才更新正文的对应章节，并链接支持证据。主题需要继续拆分时，须同步索引与
跨文档引用，让每条事实保有一个维护位置，不能复制出第二份清单。

正文中已迁出章节的原标题保留为兼容锚点，其内容只提供导航。
新引用直接链接事实所属文档；迁出内容保留原有事实、日期、版本、测量限制及
未验证项。本次仅整理文档，未重新测量成本或改变已有结论。

## Decision

**The gate stays a single, uniform cost. There is no fast lane.**

Every gated command runs the same complete sequence:

1. `scripts/check-static.sh` — Prettier format check, ESLint with zero
   warnings, `check:size` file caps (issue #432), `typecheck:strict`.
   Fail-fast, ahead of all coverage work. The file-cap contract and its
   retained function-level verification gap are recorded in
   [File Size Guard](file-size-guard.md).
2. `npm run test:coverage` — the full frontend suite, serialized to LCOV and
   threshold-checked against the versioned 80% overall line-coverage floor
   (issue #393).
3. `scripts/rust-coverage.sh` — `cargo-llvm-cov` over the library and the
   `media_format_leaf` test target, after which the same 80% floor is
   re-checked on both LCOV reports (frontend and Rust) before any analysis is
   published (issue #393).
4. `scripts/check-rust-module-graph-guard.sh` — a semantic liveness check on
   the Rust module-graph guard itself (issue #471): it reads
   `cargo test --lib -- --list` output and requires at least 90 enumerated
   `module_graph::` tests, so deleting the guard's only mount point in
   `lib.rs` (or emptying the module) fails the gate instead of silently
   dropping every guard case. Runs serially after the Rust coverage phase —
   deliberately outside the parallel vitest suite, where a cold cargo build
   starved sibling subprocess tests (8 timeouts observed at commit
   `0e80937`); CI enforces the same check in its rust job after
   `cargo test`.
5. `sonar-scanner` publishing the analysis, then waiting for the Quality Gate,
   then a separate check that new-code unresolved issues are zero.
6. Since issue #355, a fully passing run appends one summary record to a
   pending file inside `.git`, and the `pre-push` hook materializes pending
   lines into the versioned `docs/development/gate-history.jsonl` after its
   gate passes (see
   [Gate Run Evidence Record](quality-gate-evidence.md#gate-run-evidence-record-issue-355)). This step
   observes and records; it checks nothing and adds no variant of the gate.

提交创建路径及同次操作去重见[标记归属与复用](quality-gate-lifecycle.md#commit-marker-ownership-and-reuse)。
未覆盖路径与逐命令差异以[门禁覆盖清单](quality-gate-enforcement.md#what-the-gate-actually-enforces)为唯一事实源。

This is option C of issue #356. The issue did not argue for lower quality
requirements; it argued that the "cost tier" question deserved one explicit
decision and a recorded baseline. Both now exist.

There is no cheaper or faster variant of that sequence, and no configuration
that selects one. Which commit-producing commands actually reach it — and which
currently do not — is recorded precisely in
[What The Gate Actually Enforces](quality-gate-enforcement.md#what-the-gate-actually-enforces).

### Commit Marker State And Invariant Matrix (Issue #429)

[标记状态与不变量矩阵](quality-gate-lifecycle.md#commit-marker-state-and-invariant-matrix-issue-429)的兼容入口；详细内容只在目标文档维护。

### 门禁测试标记隔离（Issue #428）

[测试标记隔离](quality-gate-lifecycle.md#门禁测试标记隔离issue-428)的兼容入口。

### 门禁锁的人工恢复（Issue #430）

[锁恢复指引与诊断命令契约](quality-gate-lifecycle.md#门禁锁的人工恢复issue-430)的兼容入口。

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
[What The Gate Actually Enforces](quality-gate-enforcement.md#what-the-gate-actually-enforces)), what option
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

The following decisions must not be conflated (评审 4120364296):

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
  [Push-Path Per-Ref Gating](quality-gate-push.md#push-path-per-ref-gating-issue-405). It
  introduces no cheaper variant of the sequence: the fast path is the same
  complete sequence in the current working tree, taken only when that tree
  is provably identical to the pushed commit, and the slow path is the same
  complete sequence in a temporary worktree checked out at the pushed
  commit.

  [issue #462](https://github.com/hailingu/PlotWeave/issues/462) 为慢路径依赖安装
  增加期限，并将 Sonar 环境变量与安装、检查、覆盖率执行分离；仍执行 lifecycle，
  被推树的 `.npmrc` 仍生效。完整的执行、凭据及进程清理边界见
  [安装执行与认证边界](quality-gate-push.md#安装执行与认证边界)。这些失败防护不缩减门禁步骤；
  下方成本数据仍是修复前的历史测量，未因本次变更重新测量。

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

测试专用注入项与其保留边界统一记录在[测试注入边界](quality-gate-lifecycle.md#test-injection-boundary)；这些入口不授权绕过门禁。

Anyone reading a faster local workflow elsewhere in this repository should
treat it as a defect in that workflow, not as sanctioned by this decision.

## Push-Path Per-Ref Gating (issue #405)

[逐 ref 推送门禁](quality-gate-push.md#push-path-per-ref-gating-issue-405)的兼容入口；分派、回归矩阵及已知边界只在目标文档维护。

## Gate Run Evidence Record (issue #355)

[门禁运行台账](quality-gate-evidence.md#gate-run-evidence-record-issue-355)的兼容入口；字段、可信度边界与复现命令只在目标文档维护。

## What The Gate Actually Enforces

[命令覆盖清单与实测说明](quality-gate-enforcement.md#what-the-gate-actually-enforces)的兼容入口。

## Known Finding: Uncovered Commit-Creation Paths

[未覆盖的提交创建路径](quality-gate-enforcement.md#known-finding-uncovered-commit-creation-paths)的兼容入口；完整清单只在目标文档维护。

## Known Finding: Push Scans The Checked-Out Tree, Not The Pushed Ref

[推送对象错配的历史证据](quality-gate-push.md#known-finding-push-scans-the-checked-out-tree-not-the-pushed-ref)的兼容入口；已实施的修复与残余边界见同一目标文档。

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

**Reachability caveat (issue #463).** The fast/slow comparison above is
conditional on the fast path being *reachable*, and in daily workflow it
usually is not: besides the pushed commit being `HEAD`, the fast path also
requires the tracked worktree and index to be identical to `HEAD` and no
untracked non-ignored file anywhere in the repository — and two routine
facts defeat that. The push's own trailing `materialize` dirties the tracked
`docs/development/gate-history.jsonl` after every successful code-bearing
push, and any untracked ordinary file (drafts, new documents, scratch notes)
independently forces isolation. Treat the slow path as the practical default
when estimating routine push cost; the ~44s delta therefore understates
everyday push cost relative to the fast-path median. The preconditions, the
causality, and the recovery conditions are maintained in
[快路径可达性与恢复条件](quality-gate-push.md#快路径可达性与恢复条件issue-463).

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
  `cherry-pick`, `rebase` replays, and subtree merge/rejoin commits routed
  through `git merge --no-ff` were closed by the issue #404 wiring on
  2026-09-28; initial rejoins using `subtree add` remain uncovered.) Either way,
  update
  [What The Gate Actually Enforces](quality-gate-enforcement.md#what-the-gate-actually-enforces) in the same
  change — that table is a measurement, and a stale one is worse than none.
- `pre-push` starts reading its stdin **and the gate analyzes the pushed
  commit** (for example by checking out the pushed ref into a temporary
  worktree for the scan) instead of the current working tree. Reading stdin
  alone identifies the pushed ref but does not close the dirty-worktree
  mismatch recorded in the [historical push finding](quality-gate-push.md#known-finding-push-scans-the-checked-out-tree-not-the-pushed-ref) — with uncommitted change B on the checked-out
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
  [Push-Path Per-Ref Gating](quality-gate-push.md#push-path-per-ref-gating-issue-405)): stdin is
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
(the slow-path sample above did); a repeat slow path against a recently built tree is
faster.

Record the commit under measurement and the environment table above alongside
the result, so two measurements stay comparable.
