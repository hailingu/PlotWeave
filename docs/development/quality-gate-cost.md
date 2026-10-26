# Quality Gate Cost Decision

**Applies to**: the versioned local Git hooks (`.githooks/pre-commit`,
`.githooks/pre-merge-commit`, `.githooks/prepare-commit-msg`,
`.githooks/pre-push`), `scripts/sonar-quality-gate.sh`, and the gate-run
dedup marker helper `scripts/gate-tree-marker.sh` (issue #404). Like the root
`AGENTS.md` and the other standards under `docs/development/`, this file is
written in English for agent interoperability.

**Last reviewed**: 2026-10-25

**Status**: Active — accepted decision. Recorded 2026-09-27, resolving
[issue #356](https://github.com/hailingu/PlotWeave/issues/356); extended
2026-09-28 by the issue #404 commit-creation wiring (same complete gate,
more commands routed through it — see
[What The Gate Actually Enforces](quality-gate-enforcement.md#what-the-gate-actually-enforces)) and by
the issue #355 evidence record (one summary line per fully passing run,
written to a pending file inside `.git` and materialized into the versioned
file (originally after a passing push; since PR #581 评审 5537970549, at
the next commit's fold) — see
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
[快路径可达性与恢复条件](quality-gate-push.md#快路径可达性与恢复条件issue-463));
extended 2026-10-16 by the **gate CPU budget** (owner direction, recorded
here rather than via a tracker issue): coverage-phase parallelism is capped
at a fixed default of 4, overridable with a positive integer
`PLOTWEAVE_GATE_CPU_BUDGET` — a scheduling change only; the
check set, sequence, thresholds, and failure semantics are unchanged (see
[Gate CPU Budget](#gate-cpu-budget-2026-10-16-owner-direction) and the
re-measured [CPU-Budget Baseline](#cpu-budget-baseline-2026-10-16)).

extended 2026-10-18 by the **scoped push gate** (owner direction): commit-creating
hooks remain the complete uniform gate; `pre-push` now routes docs-only,
single-frontend, single-Rust, single-native, and cross-stack/tooling ranges
to the minimum sufficient check set (see
[Scoped Push Cost](#scoped-push-cost-2026-10-18-owner-direction) and
[Scoped Push Routing](quality-gate-push.md#scoped-push-routing-2026-10-18));
clarified 2026-10-24 for
[issue #807](https://github.com/hailingu/PlotWeave/issues/807): the absolute
"every hook runs the complete gate / nothing reduces the check set" wording in
the Decision tail and [Impact On Gate Strength](#impact-on-gate-strength) is
now scoped to the commit-creating hooks and links the push-path routing — a
consistency fix only; no hook, threshold, or governance decision changed; and
baseline refreshed 2026-10-25 for
[issue #733](https://github.com/hailingu/PlotWeave/issues/733): the frontend
suite baseline (plain uncapped and gate-capped) now records the scripts
meta-test share and cost structure, and the frontend coverage phase's share
crossed the single-phase mark — the option-level revisit that crossing demands
is the cost-structure evaluation recorded in the same change, which adopts no
lever and changes no gate step (see
[Frontend Suite And Meta-Test Baseline](#frontend-suite-and-meta-test-baseline-2026-10-25-issue-733)).

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
| 成本决策、各次成本基线、慢路径成本、触发条件及复测方法 | 本文对应既有章节 |
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

**Commit-creating hooks stay a single, uniform cost.** `pre-push` is scope-routed by owner decision 2026-10-18 (see [Scoped Push Cost](#scoped-push-cost-2026-10-18-owner-direction)). Every commit-gated command runs the following complete sequence. Full-scope pushes additionally run native functional regression after coverage and before Sonar (PR #604 review 5560989008); the commit cost stays unchanged:

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
4. `sonar-scanner` publishing the analysis, then waiting for the Quality Gate,
   then a separate check that new-code unresolved issues are zero.
5. Since issue #355, a fully passing run appends one summary record to a
   pending file inside `.git`. Since issue #548 the ordinary commit paths
   (`pre-commit` / `pre-merge-commit`) fold and stage those pending lines
   into the commit being created before the gate runs — the only drain
   point; since PR #581 评审 5537970549 the push path no longer
   materializes, and push-path records drain at the next commit's fold
   (see
   [Gate Run Evidence Record](quality-gate-evidence.md#gate-run-evidence-record-issue-355)). This step
   observes and records; it checks nothing and adds no variant of the gate.
   The server-side evidence check issue #548 added on top (the CI
   `gate-evidence` job reading that ledger) is verification of the recorded
   evidence, not a gate variant, and does not change this sequence or its
   cost.


## Scoped Push Cost (2026-10-18 Owner Direction)

The owner directed that `pre-push` may skip work that cannot be affected by the
pushed diff, while commit-creating hooks keep the complete uniform gate. This
is a deliberate gate-strength change, not an optimization hidden in a script.

| Push range | Checks | Coverage | Expected cost relative to full |
| --- | --- | --- | --- |
| docs-only (`docs/**`, root Markdown, `LICENSE`) | `scripts/check-docs.sh` (`git diff --check`) only | none | near-zero; no npm install, tests, Rust, or Sonar |
| single frontend (`src/**`, frontend-only root configs), clean checked-out head | static checks + full frontend suite | frontend full; Rust reuses the most recent LCOV | one stack's coverage + Sonar |
| single Rust (`src-tauri/**`, `crates/**`, `rust-toolchain.toml`), clean checked-out head | static checks + full Rust suite | Rust full; frontend reuses the most recent LCOV | one stack's coverage + Sonar |
| single native (`native/**`), clean checked-out head | static checks + `sh scripts/test-native.sh` (canvas build + serial functional regression; stress measurements opt in) | no native LCOV; frontend/Rust reuse the most recent LCOV | functional regression time + Sonar |
| single-stack temporary-worktree slow path; cross-stack / tooling / unknown / empty / no baseline | static checks + frontend/Rust suites + native functional regression + Sonar | frontend + Rust full | existing baseline plus native functional regression |

Boundaries:

- "Coverage is fully updated" means **the changed stack's full stack coverage**,
  not changed-line-only coverage. The unchanged frontend/Rust stack reuses the
  most recent main-worktree LCOV; a missing/empty/report without covered lines
  fails closed instead of silently omitting a report.
- A reused LCOV can be stale if the unchanged stack moved since that report.
  Existing refs require their remote old tip locally; a missing tip runs `full`.
  Only new refs fall back to local `dev` merge-base, `origin/dev`, or the commit
  parent. All ranges for a shared commit are combined before deduplication;
  different implementation stacks require `full`. Single-stack LCOV reuse is
  limited to the fast path: the pushed commit is checked out and the index,
  tracked files and all untracked non-ignored inputs match it. A non-checked-out
  ref or dirty worktree takes the temporary-worktree slow path; the hook emits
  `PRE_PUSH_SCOPE_ESCALATED` and automatically runs `full`, including native
  functional regression, because reused LCOV cannot be attributed to that tree
  ([issue #805](https://github.com/hailingu/PlotWeave/issues/805)). The single-stack
  cost rows therefore apply only to the fast path.
- Every `full` push conservatively runs native functional regression, so adding
  another stack or losing the baseline cannot remove native checks. `pre-push`
  forces `PLOTWEAVE_GATE_FULL_NATIVE=1`; all three commit-creating entry points
  force `0` to retain their uniform cost. Direct calls default to `0`; a manual
  full-push check must set `1`. Invalid values fail before checks.
- Native code is not part of the Sonar sources; the `native` scope records that
  boundary and still requires functional regression to pass. 所有者在 PR #604
  （2026-10-18）选择将持续性能、长循环内存及首拖测量改为
  `sh scripts/test-native.sh stress` 按需运行；测试方法与保留边界见
  [Native Regression And Stress](quality-gate-push.md#native-regression-and-stress)。
- Docs-only pushes do not write a push ledger record. The ordinary commit-gate
  record remains the evidence; a docs-only commit created without the commit
  hook has no record, which is the same hook-coverage boundary as before.
- The scoped paths were introduced on 2026-10-18. A measured cost baseline for
  each path, including native participation in `full` pushes, is a follow-up
  measurement; historical baseline figures below measure the frontend/Rust
  sequence and do not include this added native work. No cheaper-path claim is
  made. Revisit this decision if the scoped paths approach the full-gate cost,
  if stale-LCOV reuse causes an escaped regression, or if commit hooks are
  proposed to share the routing.

提交创建路径及同次操作去重见[标记归属与复用](quality-gate-lifecycle.md#commit-marker-ownership-and-reuse)。
未覆盖路径与逐命令差异以[门禁覆盖清单](quality-gate-enforcement.md#what-the-gate-actually-enforces)为唯一事实源。

This is option C of issue #356. The issue did not argue for lower quality
requirements; it argued that the "cost tier" question deserved one explicit
decision and a recorded baseline. Both now exist.

For the commit-creating hooks there is no cheaper or faster variant of that
sequence, and no configuration that selects one; the scoped push routing
(2026-10-18 owner direction,
[Scoped Push Cost](#scoped-push-cost-2026-10-18-owner-direction)) is the only
owner-approved exception and applies to `pre-push` only, never to commit
creation. Which commit-producing commands actually reach it — and which
currently do not — is recorded precisely in
[What The Gate Actually Enforces](quality-gate-enforcement.md#what-the-gate-actually-enforces).

### Gate CPU Budget (2026-10-16, owner direction)

Recorded owner decision, taken directly from the repository owner on
2026-10-16 (not via a tracker issue): the gate's coverage phases run with
**parallelism capped by a CPU budget**. The original form derived the cap
from the machine (`floor(cpus / 3)`, minimum 1); later the same day the
owner directed (PR #581 评审 5545658713) that the **unset default become a
fixed `4`**, independent of core count — a deterministic default keeps
local runs and test expectations machine-independent. Motivation: the two
coverage phases each saturated all performance cores for tens of seconds —
vitest forks one worker per logical core by default, and `cargo-llvm-cov`
compiles and executes tests across all of them — which the owner
experienced as sustained chassis heat on every gated operation. The cap
spreads the same work over fewer cores: peak power drops, wall time rises
([CPU-Budget Baseline](#cpu-budget-baseline-2026-10-16)).

Issue #601 also applies the same positive-integer budget (unset: fixed `4`) to `scripts/test-native.sh` through Xcode `-jobs`. Tests remain serial. Normal native regression collects a separate App line-coverage report; stress disables instrumentation. This applies locally and in native CI, while plain npm/other CI commands below retain their existing policy. Native remains absent from the uniform commit-creation cost. See [Native Coverage](native-coverage.md).

- **Scope**: `scripts/sonar-quality-gate.sh` (frontend coverage runs as
  `npm run test:coverage -- --maxWorkers <budget>`) and
  `scripts/rust-coverage.sh` (build parallelism `--jobs <budget>`; test
  execution `RUST_TEST_THREADS=<budget>`), including standalone
  `rust-coverage.sh` invocations, which resolve the same default when run
  outside the gate. Plain `npm test`, `npm run build`, and frontend/Rust CI are
  deliberately **not** capped — CI never runs this gate (Sonar stays
  local), and the cap is a local-machine comfort measure, not a repo-wide
  test policy.
- **Override**: `PLOTWEAVE_GATE_CPU_BUDGET` (positive integer) replaces the
  default (fixed `4` when unset) in both scripts. The gate resolves and validates it once
  and exports the resolved value, so `rust-coverage.sh` and the gate's test
  doubles read the same number. An invalid value (non-numeric, zero,
  negative) fails the gate with the stable diagnostic code
  `[GATE_CPU_BUDGET_INVALID]` — no silent fallback to full parallelism.
- **Gate strength**: unchanged. The same complete sequence runs with the
  same thresholds; nothing is skipped, reduced, or tiered. This is a
  scheduling bound, not a cheaper variant: the commit-creation "no
  environment variable … reduces the check set" invariant in
  [Impact On Gate Strength](#impact-on-gate-strength) keeps holding, because
  `PLOTWEAVE_GATE_CPU_BUDGET` can only change how many cores execute the
  checks, never which checks execute. Setting it to the full logical-core
  count restores the uncapped schedule; that is an owner choice about
  comfort, not a bypass of the gate.

### Commit Marker State And Invariant Matrix (Issue #429)

[标记状态与不变量矩阵](quality-gate-lifecycle.md#commit-marker-state-and-invariant-matrix-issue-429)的兼容入口；详细内容只在目标文档维护。

### 门禁测试标记隔离（Issue #428）

[测试标记隔离](quality-gate-lifecycle.md#门禁测试标记隔离issue-428)的兼容入口。

### 门禁锁的人工恢复（Issue #430）

[锁恢复指引与诊断命令契约](quality-gate-lifecycle.md#门禁锁的人工恢复issue-430)的兼容入口。

## Status Of The Alternatives

Issue [#498](https://github.com/hailingu/PlotWeave/issues/498) addresses the
test workload inside the coverage phase without changing this gate decision.
Git routing and marker tests use a gate boundary probe where repeating the
whole pipeline does not verify an additional invariant. Dedicated pipeline
tests and selected real Git integration cases still execute the full gate;
the production hooks, coverage entry, thresholds, and test parallelism remain
unchanged. Measurements, scenario choices, and preserved integration coverage
are recorded in [门禁测试负载与夹具成本](test-workload.md). (Since 2026-10-16
the *gate path* runs those same tests under the
[Gate CPU Budget](#gate-cpu-budget-2026-10-16-owner-direction) parallelism
cap — scheduling only; #498's statement above is a point-in-time fact as of
2026-10-03, and the standalone `npm test` entry remains fully parallel.)
Since 2026-10-25 that fully-parallel entry's wall clock is itself measured:
the meta-test critical path — `scripts/pre-push-refs.test.ts` — holds it,
and issue #733's cost-structure evaluation records the levers against it
(see
[Frontend Suite And Meta-Test Baseline](#frontend-suite-and-meta-test-baseline-2026-10-25-issue-733)).

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
  out. `pre-push` reads the refs Git hands it on stdin and gates every unique
  pushed commit once, at that commit's own state — see
  [Push-Path Per-Ref Gating](quality-gate-push.md#push-path-per-ref-gating-issue-405).
  As introduced it ran the same complete sequence on both paths — the fast
  path in the current working tree, taken only when that tree was provably
  identical to the pushed commit, and the slow path in a temporary worktree
  checked out at the pushed commit — with no cheaper variant. Since the
  2026-10-18 scoped push routing (next bullet) the check set per pushed
  range is scope-selected, while #405's per-commit dispatch invariant — one
  gate run per unique pushed commit, at that commit's own state — is
  unchanged.
- The **CPU budget extension (2026-10-16) also deliberately changes gate
  behavior — scheduling only**: the coverage phases run under the
  one-third-of-cores parallelism cap recorded in
  [Gate CPU Budget](#gate-cpu-budget-2026-10-16-owner-direction). It adds no
  weaker variant, skip, or fast path: the check set, sequence, thresholds,
  and failure semantics are identical, and an invalid budget *blocks* the
  operation rather than relaxing anything.
- The **scoped push extension (2026-10-18, owner direction) also
  deliberately changes gate behavior — push path only**: `pre-push` routes
  each pushed range to the minimum sufficient check set (docs-only,
  single-stack, full), while the commit-creating hooks keep the complete
  uniform gate. This is the owner-approved push-path exception recorded in
  [Scoped Push Cost](#scoped-push-cost-2026-10-18-owner-direction) and
  [Scoped Push Routing](quality-gate-push.md#scoped-push-routing-2026-10-18);
  it is not a variant the commit-creating hooks can select.

  [issue #462](https://github.com/hailingu/PlotWeave/issues/462) 为慢路径依赖安装
  增加期限，并将 Sonar 环境变量与安装、检查、覆盖率执行分离；仍执行 lifecycle，
  被推树的 `.npmrc` 仍生效。完整的执行、凭据及进程清理边界见
  [安装执行与认证边界](quality-gate-push.md#安装执行与认证边界)。这里的分离限于直接继承环境：
  macOS（本项目目标平台）上的同用户代码仍可经 `ps -Eww` 读取携带令牌的祖先进程环境，
  该能力已由 [issue #499](https://github.com/hailingu/PlotWeave/issues/499) 的实测及最小复核确认。
  此项保持为[已披露的凭据隔离残余](quality-gate-push.md#不可实现的边界同用户代码与调用者凭据隔离)，
  不要求以局部环境清理实现同用户代码的完全隔离。这些失败防护不缩减门禁步骤；
  下方成本数据仍是修复前的历史测量，未因本次变更重新测量。

The following remain in force exactly as written in `AGENTS.md`, and nothing
in this file is an exception to them:

- All four hooks stay enabled (`pre-commit`, `pre-merge-commit`,
  `prepare-commit-msg`, `pre-push`). Each commit-creating hook runs the
  complete `sonar-quality-gate.sh`; the tree marker only deduplicates within
  one commit-creating operation and never selects a cheaper check set.
  `pre-push` runs the owner-approved scoped routing
  ([Scoped Push Routing](quality-gate-push.md#scoped-push-routing-2026-10-18)):
  docs-only and single-stack ranges run the minimum sufficient check set, and
  every full-scope range still runs the complete gate.
- `--no-verify` remains prohibited, and `core.hooksPath` remains pointed at the
  versioned `.githooks/` directory.
- No new skip, allowlist, or "fast" path is introduced for commit creation:
  there, no environment variable, flag, or branch condition reduces the check
  set. On the push path, the scope variables (`PLOTWEAVE_GATE_SCOPE` and the
  reused-LCOV pointers) are that owner-approved routing rather than a bypass —
  they fail closed on missing or empty reports, and the commit-creating entry
  points force the full scope so no inherited environment can weaken a commit
  gate.
- SonarQube analysis and the Quality Gate still execute on the push path for
  every non-docs scope: single-stack scopes import both stacks' reports (the
  unchanged stack through its most recent LCOV), and full scopes run the
  complete analysis. Docs-only pushes skip them by the same owner decision
  recorded in
  [Scoped Push Routing](quality-gate-push.md#scoped-push-routing-2026-10-18).
- A failed or unavailable gate still blocks the Git operation.
- The New Code period incremental zeroing rule is unchanged: new-code unresolved
  issues must be zero, while historical issues on overall code stay triaged
  separately.

测试专用注入项与其保留边界统一记录在[测试注入边界](quality-gate-lifecycle.md#test-injection-boundary)；这些入口不授权绕过门禁。

Anyone reading a faster local workflow elsewhere in this repository that no
recorded owner decision approves should treat it as a defect in that
workflow, not as sanctioned by this decision.

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

Four measurements live here. The **founding baseline (2026-09-27)** is what
the decision above was taken against, as delivered by PR #403. The
**refreshed baseline (2026-09-30)** measures the complete gate as it exists
after the issue #404 commit-creation wiring, the issue #393 coverage floor,
and the issue #355 evidence record were added to it, and it runs on the Node
version pinned by `.nvmrc` (the founding run did not — see its caveats). The
**CPU-budget baseline (2026-10-16)** measures the same complete gate with
coverage-phase parallelism capped per the
[Gate CPU Budget](#gate-cpu-budget-2026-10-16-owner-direction) — the schedule
every gated operation uses today, so compare future measurements against it
first. The **frontend suite and meta-test baseline (2026-10-25, issue #733)**
refreshes both the plain uncapped `npm test` entry and the capped complete
gate at the budget-4 default, and records the per-file span distribution, the
scripts meta-test share, and the cost-structure evaluation that maintains the
status quo. The earlier baselines are retained because the decision and the
alternatives analysis above were argued on their numbers; when comparing
back to them, note the OS-version gap recorded in the CPU-budget caveats.

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
2. **Node version does not match the pin.** `.nvmrc` selects 24.18.0 and
   `package.json` `engines` requires Node >= 24.18.0, but the measuring shell ran Node
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
| Node.js | **v24.18.0** — matches the `.nvmrc` selection and satisfies the `engines` minimum |
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

### CPU-Budget Baseline (2026-10-16)

Taken 2026-10-16 on task branch `fix/548-gate-server-side-fallback` with the
CPU-budget change applied to the working tree (scripts, gate tests, and the
documents updated by the same change — the gate analyzed that tree), warm
build caches, Node v24.18.0 (pinned). Same machine as both prior baselines,
now on macOS 27.0.1 (they ran on 26.6.2). Budget in effect: **5**
(16 logical CPUs → `floor(16 / 3)` — the original derived default; the
unset default is now a fixed `4`, so these figures remain the budget-5
measurement point).

**Command** (unchanged form, run from the repository root
`/Users/guhailin/Git/PlotWeave`):

```sh
/usr/bin/time -p sh scripts/sonar-quality-gate.sh
```

**Result**: all three runs exit 0 — `Quality Gate 已通过，新增代码未解决问题为 0`.

| Measurement | Value |
| --- | ---: |
| Wall clock, complete gate — runs of 161.54s / 164.17s / 169.02s | **164.17s (median)** |
| User CPU / System CPU (median run) | 315.40s / 46.82s |
| Uncapped comparison (refreshed baseline median, 2026-09-30, same machine) | 135.49s |

#### Per-phase breakdown (capped)

Timed separately after the three complete runs, in the order the gate script
runs them; the uncapped column repeats the refreshed baseline's figures.

| Phase | Wall clock | Uncapped | Delta |
| --- | ---: | ---: | ---: |
| `scripts/check-static.sh` (format + lint + `typecheck:strict`) | 12.49s | 12.8s | ~0 (not capped; single-threaded tools) |
| `npm run test:coverage -- --maxWorkers 5` | 53.19s | 41.8s | +11.4s (+27%) |
| `scripts/rust-coverage.sh` (`--jobs 5`, `RUST_TEST_THREADS=5`) | 66.71s | 48.3s | +18.4s (+38%) |
| `sonar-scanner` + Quality Gate wait (remainder) | ~31.8s | ~32.7s | ~0 (not capped) |
| **Total (median of three complete runs)** | **~164.2s** | **~135.5s** | **+28.7s (+21%)** |

**The finding that matters: the cap trades wall time for peak power.** At
most 5 concurrent workers/jobs execute in each capped phase instead of up to
16, which is the point of the decision — lower sustained power draw, less
heat, on the owner's machine. Total user CPU rose slightly
(255.86s → 315.40s): spreading the same work across fewer cores costs some
scheduling and cache efficiency. Do not read that CPU increase as a
regression the cap must claw back; it is the recorded price of the comfort
the owner asked for.

The Rust coverage phase's share reaches ~40.6% (66.71s / 164.17s) —
nominally past the ~40% single-phase mark in
[Reconsideration Triggers](#reconsideration-triggers). The crossing is
attributable to the cap itself: that phase absorbed the largest relative
slowdown (+38%) while the uncapped phases held steady, so the share moved
without any change to what the phase does. The option-A-level revisit the
mark nominally demands is therefore declined **with that attribution** in
this change — the wall-time increase is the owner-accepted cost of the
budget. A future share crossing measured at an uncapped or re-tuned budget
still triggers the normal revisit.

#### Environment

| Component | Version |
| --- | --- |
| OS | macOS 27.0.1 (arm64), 16 cores / 64 GiB (same machine as both prior baselines) |
| CPU budget in effect | 5 (`floor(16 / 3)`) |
| Node.js | **v24.18.0** — matches the `.nvmrc` selection and satisfies the `engines` minimum |
| npm | 11.16.0 |
| rustc | 1.95.0 (`59807616e`, pinned by `rust-toolchain.toml`) |
| `cargo-llvm-cov` | 0.9.0 |
| `sonar-scanner` CLI | 7.3.0.5189 |
| SonarQube server | 26.8.0.126808 |

#### Caveats On This Baseline

1. **Working tree, not a clean commit.** Measured with the CPU-budget change
   applied in the working tree (plus a pre-existing unrelated
   `docs/development/gate-history.jsonl` materialization modification left
   untouched). The three runs appended their own records to the pending
   gate-history file inside `.git`, which fold into the next ordinary
   commit — by design, not leakage.
2. **OS-major gap versus both prior baselines.** macOS 26.6.2 → 27.0.1 sits
   between the refreshed and this baseline, on top of the founding→refreshed
   Node-major gap. Compare shares and this baseline's internal deltas; treat
   cross-baseline wall-clock deltas as approximate.
3. **Three samples on one day.** Same as the refresh caveat: medians, not a
   distribution across days; sub-second differences are not signal.
4. **User CPU rose under the cap.** Repeated from the finding above so a
   future reader does not "fix" it: +23% user CPU against +21% wall clock is
   the efficiency cost of fewer cores, accepted with the decision.

### Frontend Suite And Meta-Test Baseline (2026-10-25, issue #733)

Taken 2026-10-25 at commit `4061d0ca5e6a` (the `dev` tip; measured in the task
worktree `docs/issue-733-refresh-cost-baseline` before any file was edited),
same machine as all prior baselines (macOS 27.0.1, 16 cores / 64 GiB, Node
v24.18.0 pinned, npm 11.16.0, vitest 5.0.5). The worktree was freshly created
and installed via `npm ci` from local caches, then warmed by one unrecorded
full gate run (279.29s cold) so the recorded runs below measure the typical
repeated cost. The gate resolved its CPU budget to the unset default **4**
(the CPU-budget baseline of 2026-10-16 measured budget 5 — the derived default
of that day; compare within the same budget where possible).

#### Plain uncapped entry (`npm test`)

Three timed runs plus one JSON-reporter run for the per-file distribution:
86.67s / 84.00s / 84.76s — **median 84.76s**, 269 files / 3581 tests, 0
failures. Vitest's own summary for the middle run: `Duration 83.74s (tests
87%, environment 7%, import 5%, transform 1%)`. This confirms issue #733's
2026-10-22 measurement (84.23s wall, 3534 tests at `4e17c1c1`) and the
doubling against the 2026-09-30 coverage phase (41.8s, 2536 tests): the
growth is in test count (+41%) and in per-case real-process integration
spans, not in the product suites.

Per-file spans from the JSON run (a file's span is its own parallel window;
spans are **not additive** into a wall clock):

| File (all top-10 are `scripts/` meta-tests) | Span | Tests |
| --- | ---: | ---: |
| `scripts/pre-push-refs.test.ts` | 92.12s | 61 |
| `scripts/sonar-quality-gate.test.ts` | 54.84s | 66 |
| `scripts/verify-gate-evidence.test.ts` | 48.06s | 54 |
| `scripts/check-file-size.test.ts` | 26.01s | 91 |
| `scripts/gate-tree-marker.test.ts` | 23.55s | 26 |
| `scripts/pre-push-install.test.ts` | 19.56s | 18 |
| `scripts/test-native.test.ts` | 17.79s | 19 |
| `scripts/gate-history.test.ts` | 11.49s | 31 |
| `scripts/gate-evidence-workflow.test.ts` | 9.78s | 10 |
| `scripts/pre-push-install-watchdog.test.ts` | 6.79s | 5 |
| slowest non-`scripts/` file: `src/editor/EditorView.aiDelivery.test.tsx` | 5.29s | 7 |

Across all 269 files the span sum is 366.61s, of which `scripts/**` supplies
318.48s (**86.9%**) with 504 of 3581 tests (**14.1%**); the top-10 table
above is 309.99s (**84.6%**) with 381 tests (**10.6%**) — reproducing issue
#733's shares at the current tip.

**The finding that matters: the plain wall clock is the critical path of one
file.** In the JSON run the whole test window was 92.17s, and
`scripts/pre-push-refs.test.ts` spanned 92.12s of it — started 0.05s into the
window and ended exactly at its end. Every other file schedules inside that
window, so the plain entry's wall clock is the span of its slowest file plus
startup. Worker count cannot change it: the maxWorkers-4 plain runs recorded
in [test-workload.md](test-workload.md)（issue #681：82.87–88.22s）are
indistinguishable from the uncapped medians. Any lever that shortens *other*
files — the spawn-to-import conversion, shared seeding — cannot move the
plain wall while `pre-push-refs.test.ts` holds the path.

#### Capped complete gate (budget 4)

Three complete runs: 206.22s / 211.84s / 202.69s — **median 206.22s**, all
exit 0 (`Quality Gate 已通过，新增代码未解决问题为 0`); median-run user /
system CPU 357.92s / 73.52s. Per-phase timing taken after the three runs,
same budget as the gate resolved:

| Phase | Wall (budget 4) | Budget-5 baseline (2026-10-16) | Delta |
| --- | ---: | ---: | ---: |
| `scripts/check-static.sh` | 12.74s | 12.49s | ~0 (not capped; single-threaded tools) |
| `npm run test:coverage -- --maxWorkers 4` | 92.42s | 53.19s | **+39.23s (+74%)** |
| `scripts/rust-coverage.sh` (`--jobs 4`, `RUST_TEST_THREADS=4`) | 66.81s | 66.71s | ~0 |
| `sonar-scanner` + Quality Gate wait (remainder) | ~34.25s | ~31.8s | ~+2.5s |
| **Total (median of three complete runs)** | **206.22s** | **164.17s** | **+42.05s (+26%)** |

The Rust phase is unchanged against the budget-5 point, so the gate's growth
since 2026-10-16 is essentially all in the frontend coverage phase. That
phase's share is now **44.8%** (92.42s / 206.22s) — past the ~40% single-phase
mark in [Reconsideration Triggers](#reconsideration-triggers). Unlike the
2026-10-16 Rust crossing (40.6%, declined *with attribution* because the cap
itself caused it), this crossing tracks real suite growth — the meta-test
expansion between the two dates (scoped-push routing scenarios, verifier and
per-ref-dispatch cases) is exactly what the span table records, and the
worker-insensitivity above bounds the budget-4-vs-5 scheduling effect. No
budget-5 run was taken today, so the cap's exact residual contribution is
not isolated from this measurement. The option-level revisit the mark
demands is the cost-structure evaluation below.

#### Cost-structure evaluation (issue #733; decision: maintain status quo)

Issue #733's draft options, re-stated against the measured structure. This
change adopts **none** of them — each changes coverage shape or suite
placement and requires a recorded owner decision; the numbers here are the
decision basis (P3: record, do not fix).

| Lever | Quantified bound from this baseline | Why it does not move the plain wall |
| --- | --- | --- |
| Spawn-type checkers become importable functions, keeping 1–2 CLI-contract spawn cases (`check-file-size.test.ts`: 26.01s / 91 cases ≈ **0.29s per case** amortized, each case spawning a real node subprocess) | saving bounded by that file's 26.01s span; the issue's own per-case subprocess estimate (0.15–0.2s × 91) puts the realistic saving at **~14–18s** | the file is off the critical path (26.01s ≪ 92.12s); the plain wall stays at the `pre-push-refs` span |
| Same-seed templates promoted to module-level shared seeding | bounded at **~2–4s** (companion measurement already recorded in the issue; `gate-history.test.ts` confirmed feasible) | seeding cost sits inside off-path files; isolation policy (per-case sandbox) is untouched either way |
| CI/local layering — select where meta-test subsets run | moves the whole meta-test block off the local path | largest potential local reduction, but it is a suite-placement policy (which checks gate what), not a cost optimization — owner decision |
| Critical-path file split: `pre-push-refs.test.ts` runs 61 sequential real-push scenarios in one worker; splitting across files spreads scenarios over workers without sharing mutable repos (per-case isolation unchanged) | plain-wall upside bounded by the next-longest file (54.84s): **≤ ~37s**, minus per-split-file template re-seeding overhead | — (this is the only lever that scales the plain wall itself; it restructures a 1764-line maintained test file and its module-level fixtures) |

Constraints preserved unchanged: the per-case sandbox isolation documented
for the Git fixtures (`scripts/git-scenario-fixture.ts` — 只复用播种结果，
不共享可变仓库) and the duplication policy's no-merge-by-structure rule are
not weakened by anything here, because nothing here changes a test.

#### Caveats On This Baseline

1. **Three samples per entry on one day, in a task worktree** — medians, not
   a distribution across days; sub-second differences are not signal. The
   warm-up run absorbed the fresh worktree's cold caches; a fully cold
   machine is slower (279.29s measured for the first gate run).
2. **Spans are not wall clocks.** The per-file table and the 86.9% share use
   parallel file spans; only the critical-path statement translates spans
   into wall time, and only because the slowest file's span was verified to
   cover the window edge-to-edge in the measured run.
3. **Budget-4 point versus the budget-5 CPU-budget baseline.** The unset
   default is 4 since PR #581; no budget-5 run was taken today, so the
   phase-delta column mixes budget change and suite growth for the coverage
   phase — attribution to suite growth rests on the worker-insensitivity
   argument, not on an isolated measurement.
4. **The coverage variant is not the plain entry.** 92.42s is
   `test:coverage` (instrumented); 84.76s is the plain median. Compare each
   within its own column.

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
Both paths were measured at the 2026-09-30 hook state, before the 2026-10-18
scoped push routing made the pushed range scope-select the check set.

**Reachability caveat (issue #463).** The fast/slow comparison above is
conditional on the fast path being *reachable*, and in daily workflow it
usually is not: besides the pushed commit being `HEAD`, the fast path also
requires the tracked worktree and index to be identical to `HEAD` and no
untracked non-ignored file anywhere in the repository. Two routine facts
used to defeat that. The push's own trailing `materialize` dirtied the
tracked `docs/development/gate-history.jsonl` after every successful
code-bearing push — that cause was removed by PR #581 评审 5537970549
(the push path no longer materializes; the worktree stays clean after
pushes). Any untracked ordinary file (drafts, new documents, scratch notes)
still independently forces isolation, so treat the slow path as a realistic
possibility when estimating routine push cost. The preconditions, the
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
  stands). No single phase had passed the ~40% mark at that point. Status
  as of the [2026-10-16 CPU-budget baseline](#cpu-budget-baseline-2026-10-16):
  the Rust coverage phase's share reaches ~40.6% — nominally past the mark,
  but the crossing is attributable to the budget cap itself (that phase
  absorbed the largest relative slowdown while the uncapped phases held
  steady), and the option-A-level revisit it nominally demands is declined
  with that attribution in the baseline section. A future crossing measured
  at an uncapped or re-tuned budget fires the normal revisit. Status as of
  the [2026-10-25 frontend baseline](#frontend-suite-and-meta-test-baseline-2026-10-25-issue-733):
  the frontend coverage phase's share reaches ~44.8% at the budget-4 default
  — past the mark again, this time attributable to real meta-test suite
  growth rather than the cap. The revisit it demands is the cost-structure
  evaluation recorded in that baseline (issue #733): four levers quantified,
  none adopted — each requires a recorded owner decision. A future
  measurement re-checks the share at whatever budget is then in effect.
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
a distribution (the founding caveat 3 / refresh caveat 3). The gate resolves
its CPU budget as fixed default 4 or an explicit positive-integer
`PLOTWEAVE_GATE_CPU_BUDGET` override; record the actual budget value
alongside the environment table so two measurements stay comparable. To
measure an uncapped comparison run (not the daily schedule), set
`PLOTWEAVE_GATE_CPU_BUDGET` to the full logical-core count for that run
only.

For the per-phase split, time the three non-scanner stages individually in the
order the gate script runs them, and take the remainder as the scanner
phase — with the same budget the gate resolved (the unset default is a fixed
`4`; the 2026-10-16 baseline machine resolved the derived `5` of that day):

```sh
time sh scripts/check-static.sh
time npm run test:coverage -- --maxWorkers 4
time sh scripts/rust-coverage.sh
```

For the plain frontend entry and its per-file span distribution (the
2026-10-25 issue #733 baseline), time three plain runs for the median, then
take one JSON-reporter run: a file's span is its `testResults`
`endTime − startTime`; spans are parallel windows and never additive, and the
critical-path check is whether the slowest file's span covers the test window
edge-to-edge:

```sh
/usr/bin/time -p npm test        # ×3，比较中位数
npm test -- --reporter=json --outputFile=<临时报告>
```

For the push-path slow path (issue #405), push a non-checked-out commit to a
disposable local bare remote and time the whole push — the hook's worktree
checkout, `npm ci`, and the scope-selected gate run all sit inside it. Pick a
commit whose range classifies as `full` (cross-stack or tooling changes) to
re-measure the complete-gate slow path; docs-only and single-stack ranges run
their shorter scoped checks instead:

```sh
git init --bare -q "$(mktemp -d)/origin.git"   # 把输出路径用于下行
/usr/bin/time -p git push <那个路径>/origin.git <旧提交>:refs/heads/probe-side
```

Expect the first slow-path run on a machine to pay cold dependency caches
(the slow-path sample above did); a repeat slow path against a recently built tree is
faster.

Record the commit under measurement and the environment table above alongside
the result, so two measurements stay comparable.
