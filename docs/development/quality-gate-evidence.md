# 门禁运行台账与证据边界

维护台账字段、物化时序、可信度限制与查询方法。本篇由[成本决策记录](quality-gate-cost.md#文档组织约定issue-472)
按 [issue #472](https://github.com/hailingu/PlotWeave/issues/472) 拆出，是该主题详细证据的唯一维护位置。
成本基线、重新评估触发条件与复测方法仍在[决策正文](quality-gate-cost.md#measured-baseline)。
沿用原记录的英文证据，保留测量日期、已实施修复与未验证边界；本次未新增行为或复测结论。

**整理日期**：2026-10-01

## Gate Run Evidence Record (issue #355)

Before issue #355, every artifact behind a passing gate conclusion —
`coverage/`, `.scannerwork/`, `src-tauri/target/` — was local-only and
gitignored, and `.github/workflows/ci.yml` deliberately does not run Sonar.
Issue #355 adopted **option A** (a versioned summary record) to retain the
executor's reported conclusions alongside Git tree identities. Hosted CI
cannot reach the local SonarQube server, so option B's artifacts would cover
only the checks it can run. Option A provides a durable self-report; it did
not close the gap in independently verifiable proof of local gate execution.

**Trust boundary (issue #431).** The JSONL ledger has no signature, hash chain,
or independently authenticated link to a scanner run. Anyone who can write
it can append or alter a format-valid success claim for an existing Git tree
without running the gate. A tree hash identifies content; even checking that
the tree object exists cannot authenticate the claimed execution, timestamp,
Quality Gate result, issue count, or coverage. Versioning preserves the claim
and its edit history, while trust still depends on the executor and the
record's provenance. A matching row must not be used as independent proof
that a gate ran or passed, or as authorization to skip the required gate.
This is the retained P3 evidence-credibility boundary from
[issue #431](https://github.com/hailingu/PlotWeave/issues/431); no authenticity
anchor or new enforcement mechanism is introduced.

**What is recorded.** After a run passes the *complete* sequence — static
checks, both coverage reports, the scanner, Quality Gate `OK`, and zero
new-code unresolved issues — `scripts/sonar-quality-gate.sh` appends exactly
one JSON line to a pending file inside `.git`
(`plotweave-gate-history.pending`), never to the tracked file mid-gate
(PR #415 评审 5338815626: a gate-side write to the tracked file leaves an
unstaged change that aborts the next rebase replay, checkout, or merge
updating that file). Since issue #548, `pre-commit` and `pre-merge-commit` run
`gate-history.sh materialize --stage-for-commit` before their gate: they
fold pending lines into the versioned ledger and `git add` it into the
commit being created, so the versioned ledger lags one commit (the
`prepare-commit-msg` fallback gate — revert, cherry-pick, rebase replays —
deliberately does not touch the ledger; see the timing property below).
Since PR #581 评审 5537970549, `pre-push` does not materialize either:
push-path records accumulate in the pending file and drain at the next
commit's fold, leaving the worktree clean after every push. Each record
line:

| Field | Meaning |
| --- | --- |
| `timestamp` | UTC ISO-8601 time of the record append, second precision. |
| `tree` | The gated **index tree** (`git write-tree`) — the same key the dedup marker uses, and the value a reader compares against `git rev-parse <commit>^{tree}` to find a success claim for that content. Matching does not authenticate the claim. |
| `head` | The commit `HEAD` pointed at during the run — the parent of the commit being created on pre-commit-style paths, the tip being pushed on `pre-push`. Provenance context, not the content-matching key; it does not authenticate execution. |
| `qualityGate` | The Quality Gate status for this run's analysis (`OK`; only fully passing runs are recorded). |
| `newCodeUnresolvedIssues` | Unresolved issue count on new code for this run (`0`; only fully passing runs are recorded). |
| `frontendLineCoveragePercent` / `rustLineCoveragePercent` | Line coverage computed from the same LCOV reports this run submitted (`DA` records with execution count > 0 count as covered). |

**Reproducible claim lookup and coverage check.** From the repository root,
run the following with the pinned Node version. Replace the argument `HEAD`
with the commit to inspect. It reads the ledger without changing it and uses
original Git objects (`GIT_NO_REPLACE_OBJECTS=1`, matching the push gate).
Malformed JSON or an unavailable target commit makes the command fail rather
than produce a success conclusion.

```sh
node --input-type=module - HEAD <<'NODE'
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const options = {
  encoding: 'utf8',
  env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
};
const git = (...args) => execFileSync('git', args, options).trim();
const commit = git('rev-parse', '--verify', `${process.argv[2]}^{commit}`);
const tree = git('rev-parse', '--verify', `${commit}^{tree}`);
const records = readFileSync('docs/development/gate-history.jsonl', 'utf8')
  .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
const successClaims = records.filter((record) =>
  record.qualityGate === 'OK' && record.newCodeUnresolvedIssues === 0);
const claimedTrees = new Set(successClaims.map((record) => record.tree));
const commitTrees = git('log', '--format=%T', 'HEAD').split('\n');
const headTrees = new Map(records.map((record) => [record.head, null]));
for (const head of headTrees.keys()) {
  const result = spawnSync('git', ['rev-parse', '--verify', `${head}^{tree}`], options);
  headTrees.set(head, result.status === 0 ? result.stdout.trim() : null);
}
const matchingSuccessClaims = successClaims.filter((record) => record.tree === tree).length;
console.log(JSON.stringify({
  commit, tree, matchingSuccessClaims,
  conclusion: matchingSuccessClaims ? 'RECORDED_CLAIM_UNAUTHENTICATED' : 'NO_RECORDED_CLAIM',
  records: records.length,
  uniqueSuccessClaimTrees: claimedTrees.size,
  commitsReachableFromHEAD: commitTrees.length,
  commitsWithMatchingClaim: commitTrees.filter((value) => claimedTrees.has(value)).length,
  recordsWithHeadTreeMismatch: records.filter((record) =>
    headTrees.get(record.head) !== null && headTrees.get(record.head) !== record.tree).length,
  recordsWithUnavailableHead: records.filter((record) => headTrees.get(record.head) === null).length,
}, null, 2));
NODE
```

- `RECORDED_CLAIM_UNAUTHENTICATED` means only that a success claim with the
  same tree exists. A manually appended format-valid row produces the same
  outcome; this recipe cannot distinguish it from a tooling-generated row.
  `NO_RECORDED_CLAIM` means no matching success claim was found, not that the
  gate failed or never ran.
- `head` is not the lookup key. On commit-creating paths the recorded `head`
  is the pre-creation HEAD, normally the parent; staged content becomes the
  new commit's tree. When that tree differs from the parent's tree,
  `git rev-parse <record.head>^{tree}` will not equal `record.tree`. An
  unchanged-tree commit can match by coincidence. On push paths, since
  issue #405, `head` is the pushed commit and its tree matches the record.
  Legacy push records can instead reflect the earlier checked-out-tree
  behavior described in the linked known finding. A head mismatch alone
  establishes neither a failed gate nor a forged record.
- The coverage counts use commits reachable from the current `HEAD`, not
  every ref in the repository. Multiple runs can claim the same tree, and
  multiple commits can share a tree; neither record count nor unique tree
  count is a count of commits independently shown to have been gated.
  The versioned ledger at `86469b8` contains 71 successful records for 34
  distinct trees, and 1,239 commits are reachable from that snapshot. These
  counts use the tracked historical input, not a current coverage guarantee;
  the command above recomputes the current snapshot. Reproduce the historical
  counts independently with:

  ```sh
  node --input-type=module <<'NODE'
  import { execFileSync } from 'node:child_process';
  const git = (...args) => execFileSync('git', ['--no-replace-objects', ...args], { encoding: 'utf8' });
  const records = git('show', '86469b8:docs/development/gate-history.jsonl')
    .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const successClaims = records.filter((record) =>
    record.qualityGate === 'OK' && record.newCodeUnresolvedIssues === 0);
  console.log(JSON.stringify({
    successfulRecords: successClaims.length,
    uniqueSuccessClaimTrees: new Set(successClaims.map((record) => record.tree)).size,
    commitsReachableFromSnapshot: Number(git('rev-list', '--count', '86469b8')),
  }, null, 2));
  NODE
  ```

  Missing rows can reflect pre-ledger history, uncovered creation paths,
  best-effort write failures, or pending/not-yet-versioned records. Their
  presence or absence cannot establish repository-wide gate compliance.

**Deliberate properties and boundaries.**

- *Success-only tooling writes.* The gate script appends only after all
  checks pass; failed or blocked runs append nothing. This describes the
  script's behavior, not a guarantee that every ledger row came from it.
  Aborted commit operations can also leave records of successful gate runs.
  The ledger reports successes, without an exhaustive execution history or
  independently authenticated outcomes.
- *Best-effort writes, drain under the gate lock.* A pending-append failure
  (permissions, disk) prints a warning to stderr and does not block the
  already-passing gate — the same philosophy as the tree marker.
  `materialize` waits for the **same mutex the gate holds** (second-granularity
  polling of the `.sonar-gate.lock` directory) and drains
  pending → versioned while holding it: record appends happen only under
  that lock, so a concurrently passing gate cannot have its record truncated
  away in the drain window (PR #415 评审 5339243902). A lock-wait timeout —
  or a malformed timeout configuration — warns and leaves the lines pending
  for the next fold; materialize never blocks or fails the operation. If the
  append into the versioned file succeeds but the pending-file truncation
  fails, the next materialize can duplicate lines — benign under log
  semantics — and a materialize killed with SIGKILL can leave a stale lock.
  Gates do not detect or reclaim stale locks; a failed acquisition provides
  the [manual recovery instructions](quality-gate-lifecycle.md#门禁锁的人工恢复issue-430), to use only
  after confirming that no gate or materialization process is running.
  Evidence must not become a
  new way to fail a clean gate or push.
  排水还要求非空工作树台账以换行终止（[评审 5544522794](https://github.com/hailingu/PlotWeave/pull/581#pullrequestreview-5544522794)）：
  在同一锁内、追加和清空前预检，不满足时输出
  `[GATE_HISTORY_UNTERMINATED_LEDGER]` 并保留台账、索引与 pending，
  开发者补换行并暂存后可重试；Node 或读取不可用时输出
  `[GATE_HISTORY_BOUNDARY_UNAVAILABLE]` 并同样保留输入。裸物化和提交入口共用此规则，
  空文件与无文件引导态不受阻止。
- *Materialize timing and the one-commit lag.* Gate runs write only to the
  pending file inside `.git`, so they never dirty the tracked file mid-gate
  and never interfere with subsequent Git steps. The pending file drains
  **only at commit-creation folds**: `pre-commit` and `pre-merge-commit` —
  the ordinary commit and merge paths, which reliably adopt hook staging —
  run `materialize --stage-for-commit` **before** the gate, folding the
  pending lines into the versioned file and `git add`ing the ledger into
  the commit being created. Auto-staging is attribution-guarded by the
  **exact pending bytes** (PR #581 评审 5537970549/5544334841): it fires only while
  the worktree ledger is byte-exactly the index content plus the lines
  folded in this run, each parseable as JSON; EOF newline bytes are not
  normalized, and only folded content is decoded for JSON validation — the developer's staged
  selection is preserved verbatim, and any other unstaged ledger change
  (a syntactically valid manual append included; a modified/deleted
  existing line; a malformed or polluted line; a manual partial staging; an
  undecidable state with Node unavailable) warns
  `[GATE_HISTORY_UNATTRIBUTED_CHANGE]` and keeps the developer's staging
  untouched. A **staged deletion** of the ledger — the path absent from the
  index while present in `HEAD` — is its own state (PR #581 评审
  5542467935): the fold rebuilds only the worktree file, the hook warns
  `[GATE_HISTORY_STAGED_DELETION]` and keeps the deletion staged instead of
  resurrecting the ledger via `git add` (a both-absent path is the bootstrap
  state and still folds normally). The lines are carried by that commit, so no unstaged residue
  remains while the operation proceeds — the PR #415 breakage was an
  *unstaged* write; this path folds and stages into the same commit. The
  record for commit C's own gate run is therefore versioned in the **next**
  ordinary commit (C's tree contains the staged lines, so it cannot contain
  its own record — self-reference). The `prepare-commit-msg` fallback gate
  — automatic `git revert` / `git cherry-pick` commits and every
  `git rebase` replay — deliberately does **not** materialize: sequencer
  replays do not adopt hook-added staging, and the folded-but-uncommitted
  lines would abort the next replay (measured in this change's fixtures;
  the PR #415 protection is kept). Those runs' records stay in the pending
  file and fold with the next ordinary commit — after rebasing a branch,
  one follow-up ordinary commit (`git commit --allow-empty` qualifies, and
  lands as the exempt ledger-only tip) restores replay evidence before
  pushing. `pre-push` does not materialize (PR #581 评审 5537970549):
  push-path records drain at the next commit's fold like every other
  record, the worktree stays clean after pushes, and the fast path's
  ledger failure source documented in
  [Push-Path Per-Ref Gating](quality-gate-push.md#push-path-per-ref-gating-issue-405)
  is gone; a bare `gate-history.sh materialize` remains as a manual drain.
  A path-limited commit (`git commit -- <pathspec>` / `--only`) runs hooks
  against a temporary index — a hook `git add` there never reaches the real
  index, leaving a stale residue that a later ordinary commit would
  re-commit backwards — so the hook detects the temporary index and defers
  the fold entirely to the next ordinary commit (PR #581 评审 5543397069);
  that pathspec commit's own gate record keys its temporary-index tree,
  which equals the commit's tree, so evidence stays consistent.
  `git commit -a` / `--amend -a` 使用的 `index.lock` 则是 Git 会在提交后
  采纳的活动索引，和普通 `index` 一样折并并暂存台账；它不属于上述需推迟的
  pathspec 临时索引（[PR #581](https://github.com/hailingu/PlotWeave/pull/581)）。
  A record-only commit burns a full gate run and is not the norm, except as
  an optional evidence-tip commit, which the server-side check exempts when
  it only touches the ledger. Records for
  commit-side runs of commits that are never pushed stay in the local
  pending file: nothing leaves the machine, so there is no external claim
  to verify. If the commit-time `git add` fails (best-effort), the folded
  lines stay unstaged and ride with the next change; a `rebase --abort`
  after a staged fold can discard that batch — any commit that is actually
  pushed later gets a fresh push-path record, so no durable evidence gap
  remains.
- *Working tree vs. index key.* The gate analyzes the working tree (see
  [Known Finding: Push Scans The Checked-Out Tree, Not The Pushed
  Ref](quality-gate-push.md#known-finding-push-scans-the-checked-out-tree-not-the-pushed-ref)),
  while `tree` records the index tree, matching the marker's key. With
  unstaged or untracked differences the run validated more (or different)
  content than the key identifies; the caveats of that known finding apply
  to records unchanged. The file-size checker additionally validates source
  blobs and their bounded baseline in the effective index (issue #432,
  PR #452 reviews 5374354494 / 5374500480), without allowing an indexed
  allowance to weaken the current gate's policy;
  this closes its size-policy mismatch without changing the other stages.
- *Append-only growth.* One line per fully passing run, no rotation; the
  file is a log of runs, not a derived state that can be rebuilt.
- *No secrets.* Records carry hashes, counts, and percentages only. Tokens
  never reach the record path (the gate passes them via stdin/environment
  exclusively), and raw scan artifacts stay unversioned — the issue #355
  acceptance criteria require both.

### 提交索引与物化状态矩阵（PR #581）

`gate-history.sh` 的 `commit_uses_temporary_index` 负责识别有效索引，
`materialize --stage-for-commit` 负责决定是否折并；入口为 `pre-commit` 与
`pre-merge-commit`。全量与限定提交用例在 `scripts/gate-history.test.ts` 中执行
真实 Git 提交，断言最终提交内容与台账状态；内容归因用例直接执行物化脚本。

| 前置状态 | 动作与顺序 | 可观察结果 | 不变量 | 验证 |
| --- | --- | --- | --- | --- |
| pending 有记录，台账无额外改动 | `git commit -a` 在 `index.lock` 上运行钩子 | 记录进入本提交，pending 清空，台账状态干净 | Git 采纳的活动索引必须携带本次可归因的折并记录 | 全量提交用例 `-a` |
| 同上，修改既有提交 | `git commit --amend -a` → 钩子暂存 → Git 采纳锁索引 | 修改后的提交保留原台账并追加记录，无索引残留 | amend 不改变活动索引的物化义务 | 全量提交用例 `--amend -a` |
| pending 有记录，提交限定路径 | `git commit -- <pathspec>` / `--only` → 下一普通提交 | 限定提交保留台账与 pending；下一普通提交入库记录并清空 pending | 不向 pathspec 临时索引写入会与真实索引分离的台账，也不丢失待物化记录 | 两个限定提交与恢复用例 |
| 普通索引，台账含不可归因改动或已暂存删除 | 折并后归因拒绝自动暂存 | 警告且保留开发者索引选择 | 放行 `index.lock` 不放宽内容归因守卫 | 既有额外工作树内容、部分暂存、已暂存删除用例 |
| pending 为空，工作树仅增加或删除 EOF 换行 | 调用提交侧物化归因 | `GATE_HISTORY_UNATTRIBUTED_CHANGE`，索引与工作树各保留原字节 | 自动暂存不得收编任何非本次折并的字节改动 | EOF 换行增删回归（评审 5544334841） |
| 同上，但索引已含开发者选定的台账改动 | 归因失败后检查暂存区 | 原选定内容逐字保留，未暂存的 EOF 改动仍未暂存 | 归因基准是有效索引，不能覆盖部分暂存选择 | EOF 换行与部分暂存组合用例 |
| pending 有合法 JSON，尾部可有或无换行 | 先按原字节追加，再归因 | 仅当工作树恰为索引字节与本次 pending 字节拼接时自动暂存 | JSON 校验与字节归因相互独立，不能归一化索引或工作树 | 合法折并与末行未终止用例；额外工作树内容既有用例 |
| pending 含畸形新行 | 追加后逐行 JSON 校验失败 | 警告、保留原索引；折并内容留在工作树供人工处理 | 字节精确匹配不能代替折并行的合法性检查 | 畸形折并行反例 |
| 非空台账末行未终止，pending 有记录 | 提交侧或裸物化在排水前检查记录边界 | `GATE_HISTORY_UNTERMINATED_LEDGER`，工作树、索引及 pending 均保留 | 物化不得拼接破坏既有记录，也不得提前清空尚未折并的 pending | 未终止台账的两个入口反例（评审 5544522794） |
| 上述暂缓状态 | 开发者补换行并暂存，再次物化 | pending 正常入库并清空，所有行仍可解析 | 边界修复后的重试必须保留原记录与待物化记录 | 补换行后恢复用例 |
| 台账为空、不存在，或末行已有换行 | 正常物化 | 沿用既有追加、归因和暂存规则 | 边界检查不能阻止首条记录或正常追加 | 空文件、引导态与正常追加用例 |
| Node 不可用或台账读取失败 | 排水前的边界检查无法完成 | `GATE_HISTORY_BOUNDARY_UNAVAILABLE`，保留全部输入供重试 | 无法验证边界时不得追加或清空 pending | Node 不可用与既有目录占位不可写用例 |

最初的索引修复只改变索引分类；并发排水仍由既有门禁互斥锁保护，锁超时与恢复继续由
既有物化测试覆盖。sequencer 回退入口仍不调用物化。本地真实 Git 用例覆盖当前
macOS Git；其他 Git 版本与平台未在本次本地验证中实测。

EOF 归因修复由 `ledger_change_attribution` 负责，`pre-commit` 与
`pre-merge-commit` 共用同一入口；不改变排水、锁超时或临时索引延后规则。
比较时读取索引、工作树与折并捕获文件的原始字节，仅将折并内容解码后逐行
验证 JSON；并发排水仍由既有互斥锁负责，不新增重试或恢复状态。

2026-10-16 索引分类修复的本地验证：Node 24.18.0、Git 2.48.1；当时的物化测试
21/21 通过，`npm run check:size && npm test -- scripts` 的规模检查通过，完整
脚本测试在沙箱外重跑后 324/324 通过（沙箱内禁止 `ps` / `sysctl`，既有进程
身份与 CPU 预算用例不能正常验证）；`sh scripts/check-static.sh` 通过。
文档与 AGENTS.md 按路由完成结构化审阅，无配置的自动化文档检查。

2026-10-16 EOF 归因复核（评审 5544334841）：先观察 4 个换行增删与部分
暂存反例错误地改写索引，再改用原始字节拼接比较。物化测试 28/28、
`npm run check:size && npm test -- scripts` 在沙箱外 348/348 通过，
覆盖当时新增的矩阵行及既有索引、锁和恢复用例；`sh scripts/check-static.sh`、
`sh -n scripts/gate-history.sh` 与 diff 检查通过。文档及 AGENTS.md 完成
结构化审阅，无配置的自动化文档检查。平台验证边界仍为上述 macOS Git，
没有新增其他平台实测。

2026-10-16 记录边界复核（评审 5544522794）：先复现未终止台账被折并并自动
暂存的反例；提交入口和裸物化现在都暂缓排水，补换行并暂存后的重试保留旧记录
并正常折并，Node 不可用与目录不可写也保留输入。物化测试 31/31 通过；
`npm run check:size && npm test -- scripts` 在沙箱外 360/360 通过，
`sh scripts/check-static.sh`、`sh -n scripts/gate-history.sh` 与 diff 检查通过。
文档及 AGENTS.md 已按路由结构化审阅，无配置的自动化文档检查。

## Server-Side Evidence Verification (issue #548)

### tip 台账保全状态矩阵（PR #581 评审 5543678876）

`verify-gate-evidence.ts` 在应用 tip 留证滞后容差前负责台账保全；普通任务与
`--release-boundary` 使用同一守卫。比较对象为不可变 Git 提交，不涉及工作树
并发写入；重试读取同一提交得到同一结论，不新增锁或恢复流程。

| 前置状态 | 动作与顺序 | 可观察结果 | 不变量 | 验证 |
| --- | --- | --- | --- | --- |
| 父提交已有台账，tip 不改台账或保留原字节追加 | 修改源码，随后核验 tip | 可缺少自身记录并输出 `GATE_EVIDENCE_TIP_LAG` | 留证滞后不能丢失已有台账 | 既有普通 tip、单提交 PR 与追加用例 |
| tip 仅追加合法 JSON 行 | 保全检查后判定台账-only 形态 | `GATE_EVIDENCE_LEDGER_ONLY_TIP`，退出 0 | 仅纯追加的台账补充提交可豁免 | 既有物化补充、大台账用例 |
| 父提交已有台账（含空文件） | tip 删除、截断、重写，或删去原尾随换行；可同时修改源码 | `GATE_EVIDENCE_LEDGER_DESTRUCTIVE`，退出 1，无滞后放行 | 普通与发布模式都不得借 tip 容差破坏历史字节 | 删除、截断、重写、空台账、换行与混合变更用例 |
| 父台账非空且末行无换行 | tip 把垃圾或另一条 JSON 直接接在原记录后 | `GATE_EVIDENCE_LEDGER_DESTRUCTIVE`，退出 1 | 字节前缀保全不能允许追加内容改变既有记录的解析边界 | 本轮未终止末行反例（评审 5544147742） |
| 同上 | tip 保持末行不动，或先补 `\n` 再追加独立记录 | 正常滞后告警；仅合法台账追加可豁免 | 原记录无尾随换行本身不构成失败，补终止换行不破坏历史 | 末行未改、仅补换行、补换行后追加用例 |
| 父台账为空或末行已终止 | 从首行或下一行开始追加 | 沿用原有正常追加与畸形新行告警规则 | 记录边界守卫只限制对既有未终止记录的拼接 | 空台账首条、既有完整行与畸形追加用例 |
| 合并的多个父提交分别含记录 | 合并保留每个父台账的完整记录及顺序，再核验 | 正常合并仍可滞后；丢弃任一父记录则退出 1 | 合并可组合分叉追加的记录，不能丢弃父提交的历史 | 合并保留、丢弃非首父记录用例 |
| 父提交可达历史从未含台账，或仅追加畸形新行 | tip 首次引入台账或追加畸形记录 | 不因历史保全失败；畸形行仍按现有解析规则告警 | 保全守卫不把新增记录的解析策略改成历史破坏 | 首次引入、畸形行既有用例 |
| 直接父台账已删除，但祖先曾含台账 | 删除可有真实通过记录；tip 重建台账时继续查找各历史分支最近的现存台账 | 丢失旧记录输出 `GATE_EVIDENCE_LEDGER_DESTRUCTIVE`，退出 1 | 有通过记录的删除提交也不能使历史保全基准消失 | 删除后重建、连续缺文件、混合源码用例（评审 5544522794） |
| 同上，tip 完整恢复旧记录并追加删除提交的证据 | 历史保全后应用既有 tip 判定 | 通过；自身记录可滞后 | 合法恢复不能被一概拒绝，普通及发布模式共用恢复约束 | 完整恢复正例 |
| 缺文件的父提交是合并结果，两侧祖先分别有记录 | 沿全部父链找到最近现存台账，再检查恢复结果 | 缺任一侧记录失败；保留各侧记录及顺序时通过 | 历史回溯不能只检查首父，不能借合并丢失另一侧历史 | 分叉删除再合并的恢复用例 |

删除恢复检查由 `tipPreservesLedger` 负责。仅当一个缺文件的祖先历史从未触及
台账时停止回溯并按首次引入处理；否则遍历其全部父链，遇到现存台账即停止该链。
历史探测使用 `git log --full-history`，避免合并的路径简化隐藏非首父引入后又删除的台账。
比较仍使用不可变 Git 对象，不新增工作树并发、重试或锁状态。物化的边界预检
则在既有门禁互斥锁内、任何追加或清空之前执行；检查失败只警告并保留输入，
不会产生半次排水。跨平台实测边界与既有矩阵一致。

2026-10-16 删除恢复复核（评审 5544522794）：先观察有匹配通过记录的删除
提交之后，两种丢弃旧台账的重建仍退出 0；再补充复现非首父历史被路径简化隐藏。
核验脚本 43/43 通过，覆盖普通与发布模式、连续缺文件、完整恢复、两侧历史
合并及真正的首次引入。旧删除反例仍因缺证失败，并额外报告台账破坏；原先误用
删除重建表示首次引入的夹具已更正为从未有台账的历史。脚本全量与静态检查结果
同上。恢复约束只比较最近现存快照，不把台账自述升级为独立的门禁真实性证明。

2026-10-16 首轮本地验证（Node 24.18.0）：核验脚本 24/24 用例通过，覆盖当时的
矩阵；`npm run check:size && npm test -- scripts` 在沙箱外 331/331 通过，
`sh scripts/check-static.sh` 通过。沙箱内完整脚本测试曾因禁止 `ps` / `sysctl`
导致既有进程身份与 CPU 预算用例失败，沙箱外重跑已验证通过。本地用例运行
真实 Git 与核验 CLI；GitHub 托管 runner 的行为以推送后的 `gate-evidence` CI
为准。文档与 AGENTS.md 已按路由结构化审阅，无配置的自动化文档检查。

2026-10-16 追加边界复核（评审 5544147742）：先复现直接拼接垃圾与 JSON
两例退出 0 的缺陷，再由 `preservesLinearLedger` 强制未终止末行的追加边界。
核验脚本 34/34 用例通过，普通与发布模式覆盖未终止末行的非法拼接、合法补行
及合并入口；空台账与仅台账物化补充用例验证共享守卫的正常路径。
`npm run check:size && npm test -- scripts` 在沙箱外 341/341 通过，
`sh scripts/check-static.sh` 通过；文档与 AGENTS.md 结构化审阅通过，
无配置的自动化文档检查。不可变提交读取与既有锁策略未变，不新增并发或恢复分支。

The local gate's enforcement endpoint was the machine's own Git hooks; a
`git push --no-verify` direct push, or a PR whose commits were created
without the gate, previously had no server-side backstop. Issue #548 added
two complementary backstops (方案 1 + 方案 2):

1. **CI evidence check（方案 1）.** The `gate-evidence` job in
   `.github/workflows/ci.yml` runs `scripts/verify-gate-evidence.ts` on
   every pull request targeting `dev` or `main` (`ubuntu-latest`,
   pull-request events only — push runs contain server-created merge
   commits that have no local ledger record by design). For the range
   `merge-base(base, head)..head`, against the ledger **as versioned at the
   PR head**:
   - Every commit **except the tip** must have an evidence record: a line
     whose `tree` equals the commit tree with `qualityGate == "OK"` and
     `newCodeUnresolvedIssues == 0`. A missing record fails the check
     (`[GATE_EVIDENCE_MISSING]`, exit 1).
   - 先检查 **tip 的台账保全**（[PR #581 评审 5543678876](https://github.com/hailingu/PlotWeave/pull/581#pullrequestreview-5543678876)）：
     单父提交必须保留父台账全部原字节为前缀；非空父台账末行没有终止换行时，
     后续内容必须先补 `\n`，防止直接拼接把原 JSON 记录改成畸形行
     （[评审 5544147742](https://github.com/hailingu/PlotWeave/pull/581#pullrequestreview-5544147742)）。
     末行保持不动、仅补换行、空台账写入首条记录均可通过此检查。
     直接父没有台账时，继续沿其全部父链查找最近现存台账；只有可达历史从未
     触及台账的分支才按首次引入处理，删除后重建不能重置保全基准
     （[评审 5544522794](https://github.com/hailingu/PlotWeave/pull/581#pullrequestreview-5544522794)）。
     单一历史快照按原字节前缀保全；跨分支多个快照按完整记录及各自顺序保全，允许合法合并恢复。
     合并 tip 允许组合分叉追加，
     但必须保留每个父台账的完整记录字节与顺序。删除（包括空台账）、截断或
     非追加重写输出 `[GATE_EVIDENCE_LEDGER_DESTRUCTIVE]` 并退出 1，
     优先于任何 tip 留证容差；普通与发布模式一致。
   - The **tip** gets its own record only with the next commit (see the
     one-commit-lag property above), so a missing tip record is a warning
     (`[GATE_EVIDENCE_TIP_LAG]`, exit 0) — surfaced as a GitHub annotation.
     A tip whose only change is a **byte-preserving append** to the ledger
     (the parent's lines verbatim plus parseable appended records) is exempt
     (`[GATE_EVIDENCE_LEDGER_ONLY_TIP]`): it carries no ungated source
     change and destroys no evidence — a tip that deletes, truncates, or
     rewrites a parent ledger fails the preservation check above. Merge
     commits never qualify for the exemption (a merge can carry content);
     as tips they get the lag warning only after preserving all parent ledgers.
   - Malformed ledger lines are skipped and warned
     (`[GATE_EVIDENCE_MALFORMED_LINE]`), matching the ledger's log
     semantics; they do not fail the check by themselves.
   - The script always reads original Git objects
     (`GIT_NO_REPLACE_OBJECTS=1`, matching the push gate, PR #442).

   This check is why the ordinary commit paths now stage pending records
   into each commit (issue #548): with materialize-at-push only, the
   versioned ledger lags one full push cycle and every compliant PR would
   fail the per-commit requirement. With commit-time staging, a compliant
   multi-commit PR is fully evidenced except its tip. Replayed commits
   (rebase / cherry-pick / revert) are evidenced once one follow-up
   ordinary commit exists on the branch — the verifier's remediation
   message names that step (`git commit --allow-empty` then re-push); a
   rebased branch pushed without it fails the check on the replayed
   non-tip commits.

   **Release-PR integration boundary (PR #581 评审 5542207474/5542342537).**
   A `dev → main` release PR's range enumerates GitHub-created merge commits
   and every integrated task branch — including each task's tip, whose
   records by the one-commit-lag design are still materializing on the
   developer's machine when the release opens. The verifier therefore
   recognizes the integration boundary instead of demanding impossible
   records: merge commits in the range are skipped (server integration
   points never ran a local gate; their content was covered by the
   constituent task PRs, which branch protection makes mandatory), the
   non-first parent of an in-range merge — an integrated branch tip — gets
   the `[GATE_EVIDENCE_INTEGRATED_TIP_LAG]` warning like a range tip, and
   commits whose reachable history never touched the ledger path (issue
   #355 adoption) are exempted with `[GATE_EVIDENCE_PRE_LEDGER_COMMIT]` —
   a commit that merely deletes the ledger has touched the path and is not
   exempt. **These tolerances are gated on the explicit `--release-boundary`
   flag, which ci.yml passes only for the actual release PR — base `main`,
   head `dev`, and the head repository being this repository itself (PR
   #581 评审 5542467935/5542611194: base-only would hand the exemptions to
   any task branch opening a PR straight to `main`, and a short branch name
   alone to a fork's identically named `dev`; branch protection does not
   restrict PR source branches)**: every other PR gets
   no integration-boundary exemptions at all — its merge
   commits and non-first parents require evidence like every other commit,
   so a task branch cannot smuggle unevidenced changes through a
   merge-plus-tip shape. Every other commit in the release range still
   requires evidence, so the tolerances do not spill over ordinary history
   either.

2. **Branch protection（方案 2）.** GitHub branch protection is enabled on
   `dev` and `main` (owner decision, 2026-10-16): pull requests required
   (no approving-review count), the four `ci` jobs required as status
   checks, administrators included, force pushes and deletions blocked. A
   `git push --no-verify` direct push is rejected server-side before any
   code leaves the machine unverified.

**Remaining boundaries.** The trust boundary of
[issue #431](https://github.com/hailingu/PlotWeave/issues/431) is
unchanged: the ledger is unsigned, so the check raises the cost of
bypassing from "push with `--no-verify`" to "actively falsify the versioned
ledger inside a pushed commit", and does not authenticate that the gate
executed. A single-commit bypass PR that preserves its parent ledger surfaces
only the tip warning — it is visible at merge time but not blocking.
Destructive ledger changes fail even in a single-commit PR. The uncovered
creation paths
(`git am`, plumbing, history rewriters) produce commits without records and
therefore fail the check once they appear as non-tip commits in a PR —
remediation is to recreate the change through the gated workflow (or let
the owner adjudicate). Rebasing a branch without a follow-up ordinary
commit fails the check on the replayed commits; the remediation is the
named `git commit --allow-empty` step, not a bypass. Path-limited commits (`git commit <pathspec>`) keep
the pre-existing working-tree-versus-index boundary recorded in
[What The Gate Actually Enforces](quality-gate-enforcement.md#what-the-gate-actually-enforces):
the record keys the effective index, which the hooks also stage the ledger
into. Commits created before the issue #548 hooks staged evidence carry no
records; they fail the check until recreated or superseded.
