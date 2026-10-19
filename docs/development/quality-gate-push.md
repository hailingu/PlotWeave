# 推送门禁与对象身份

维护逐 ref 分派、验证矩阵、残余边界及历史错配证据。本篇由[成本决策记录](quality-gate-cost.md#文档组织约定issue-472)
按 [issue #472](https://github.com/hailingu/PlotWeave/issues/472) 拆出，是该主题详细证据的唯一维护位置。
成本基线、重新评估触发条件与复测方法仍在[决策正文](quality-gate-cost.md#measured-baseline)。
拆分时沿用原记录的英文证据，保留测量日期、已实施修复与未验证边界；后续处置与验证按各节日期记录。

**整理日期**：2026-10-01

## Scoped Push Routing (2026-10-18)

所有者指示（2026-10-18）在 `pre-push` 引入按变更范围分派；commit-creating
钩子（`pre-commit` / `pre-merge-commit` / `prepare-commit-msg`）仍是完整
统一门禁，不在本次放宽范围。

| 变更范围 | 判定 | 推送门禁行为 |
| --- | --- | --- |
| docs-only | 所有变更路径为 `docs/**`、根 Markdown 或 `LICENSE` | 只运行 `scripts/check-docs.sh`（`git diff --check`）；跳过静态检查、覆盖率、Sonar 与推送台账记录。commit 钩子的完整门禁记录仍是证据。 |
| frontend | 非文档路径只落在 `src/**` 与前端专属根配置 | 全量前端测试 + 前端覆盖率；Rust 复用主工作树最近 LCOV；Sonar 导入两侧报告。 |
| rust | 非文档路径只落在 `src-tauri/**`、`crates/**`、`rust-toolchain.toml` | 全量 Rust 测试 + `rust-coverage.sh`；前端复用最近 LCOV；Sonar 导入两侧报告。 |
| native | 非文档路径只落在 `native/**` | `sh scripts/test-native.sh` 构建画布并串行运行功能回归；压力测量按需运行（见下节）。前端/Rust 复用最近 LCOV；Sonar 导入两侧报告。原生代码不在 Sonar 源码范围，记录 `scope: native`。 |
| full | 跨栈、工具（`scripts/**`、`.githooks/**`、`.github/**`、根 linter/配置）、未知路径、空差异或无法确定基线 | 完整推送门禁：静态检查 + 前端/Rust 全量覆盖率 + native 功能回归 + Sonar；压力测量仍按需运行。 |

实现与边界：

- `scripts/gate-scope.ts` 从 `git diff --no-renames --name-only <base> <commit>`
  分类；已有 ref 只取远端旧 tip，若该对象在本地不可用则按 `full`。
  只有远端 SHA 全零的新 ref 才依次取本地 `dev` merge-base、
  `origin/dev`、提交父提交。无法确定时按 `full`，不因“没有差异”跳过。
- 同一提交的所有 ref 范围先收集再合并，随后才去重执行：docs 为中性，
  不同实现栈或任一 full 取 full；每个文档范围均执行差异检查。
  交换 ref 顺序不改变最终范围。三个提交创建入口显式设置
  `PLOTWEAVE_GATE_SCOPE=full PLOTWEAVE_GATE_FULL_NATIVE=0`，外部环境不能把提交门禁降为推送单栈路径，也不能继承推送专属成本。
- `full` 推送显式设置 `PLOTWEAVE_GATE_FULL_NATIVE=1`，保守执行三栈检查，
  包括合并范围、工具变更和无法确定基线；调用方的 `0` 不能降级。共享门禁
  只接受 `0`/`1`，非法值以 `[GATE_FULL_NATIVE_INVALID]` 阻断。直接调用默认
  `0`，保持既定提交门禁成本；手动验证完整推送须显式设为 `1`。
- `pre-push` 把范围经 `PLOTWEAVE_GATE_SCOPE` 传给
  `scripts/sonar-quality-gate.sh`；未变更栈的 LCOV 经
  `PLOTWEAVE_REUSED_FRONTEND_LCOV` / `PLOTWEAVE_REUSED_RUST_LCOV` 指向
  主工作树最近产物。缺文件、报告为空/无源文件/无覆盖行时 fail-closed，
  禁止 Sonar 在缺少一侧报告时静默降级。
- 单栈只跑该栈的全量回归与覆盖率；“代码覆盖率全量更新”指变更栈的完整
  栈内覆盖率，不是只测变更文件；未变更栈复用最近 LCOV，不重跑其测试。
- 原生功能回归采集独立的 Swift App 行覆盖率报告（[#601](https://github.com/hailingu/PlotWeave/issues/601)，[报告与阈值规则](native-coverage.md)），默认先报告、不设百分比下限；显式下限低于要求或源文件清单不完整时失败。采集无效与原生测试失败同样阻断推送。前端/Rust LCOV 按上述复用；Sonar 对原生源码不建模，台账的 `scope: native` 明示该边界。
- docs-only 不写推送台账；普通 commit 钩子已产生的全量记录继续作为
  gate-evidence 证据。若 docs-only 提交绕过 commit 钩子创建，则没有该
  记录——这与既有 hook 覆盖边界一致，不是新豁免。
- 单栈慢路径在临时 worktree 中运行，复用的 LCOV 来自主工作树最近门禁；
  若未变更栈代码已相对该报告变化，复用值可能陈旧。此时应运行完整门禁；
  该边界不改变“变更栈覆盖率必须刷新”的要求。

回归：`scripts/gate-scope.test.ts` 覆盖分类与 CLI；`scripts/pre-push-refs.test.ts`
覆盖 docs-only 跳过、单栈分派与复用路径；`scripts/sonar-quality-gate.test.ts`
覆盖 frontend/rust/native 分流、缺 LCOV fail-closed 与 native 失败阻断。

### PR #604 修复状态与不变量矩阵

门禁入口拥有范围选择；提交钩子拥有完整覆盖率要求；原生测试入口和
`NativeStressTestProfile` 共同拥有日常/压力选择，Xcode 在测试宿主启动前转发开关。
这些命令顺序执行，不新增异步状态；信号清理沿用既有推送监督器。

| 前置状态 | 操作/顺序 | 可观察结果 | 跨转换不变量 | 验证 |
| --- | --- | --- | --- | --- |
| 同一提交推往不同旧 tip 的多个 ref | 先收集全部范围，再按提交去重 | docs 与单栈合并为单栈；不同栈或 full 合并为 full | 交换 ref 顺序不削弱检查，每提交只运行一次代码门禁；每个 docs 差异仍须通过 | pre-push-refs 的共享提交范围与文档空白回归 |
| 已有远端 tip 对象缺失 | 推送替换已有 ref | full | 只有全零远端 SHA 能采用新分支基线回退 | pre-push-refs 的 missing-tip 回归 |
| 提交环境带有 scoped push 变量 | pre-commit / pre-merge-commit / prepare-commit-msg | full，刷新前端与 Rust 覆盖率 | 提交标记只能代表完整门禁 | sonar-quality-gate 的三个提交入口回归 |
| 默认 native 门禁或未配置开关 | 日常功能、生命周期及轻量报告校验 | Swift Testing 跳过五个压力测量 | 功能回归保留，测试失败继续非零阻断 | test-native 的参数/退出码测试；NativeStressTestProfileTests；真实日常回归 |
| 显式 native stress | Xcode 转发开关 `1`，选择测量套件 | 开启原有规模、轮数及断言 | 只有精确值 `1` 能开启；指标口径不改变 | test-native 的压力选择回归；NativeStressTestProfileTests；真实测试宿主的开关探针；本次不重复执行高负载测量 |

评审 5560989008 补充矩阵：`full` 推送保守执行三栈检查，不再丢失 native
参与；这样无需扩展分类器返回类型或维护第二份路径分类。提交入口显式关闭
推送专属的 `PLOTWEAVE_GATE_FULL_NATIVE`，保持既定的统一提交成本。

| 前置状态 | 操作/顺序 | 可观察结果 | 跨转换不变量 | 验证 |
| --- | --- | --- | --- | --- |
| native 与 frontend/tooling 混合范围，或多个 ref 合并为 full | 收集范围后选择快路径或临时 worktree | 前端/Rust 覆盖率及 native 功能回归均执行 | 增加其他栈变更不能移除 native 检查；每提交仅一次门禁 | 混合范围快/慢路径集成回归 |
| 无法确定已有远端基线 | 保守 full 推送 | 三栈检查，外部开关 `0` 无法降级 | 不确定范围不能漏掉任何实现栈 | 缺失远端 tip 回归 |
| full 推送中的 native 失败 | native 检查失败后停止扫描 | 推送失败，无成功台账记录 | 只有全部所需栈通过才可发布通过结论 | full native 失败集成及门禁回归 |
| 外部设置 full native 开关，进入任一提交创建钩子 | 入口覆盖范围和开关 | 刷新前端/Rust，不额外执行 native | 推送上下文不能改变提交创建成本或复用标记语义 | 三个提交入口环境隔离回归 |
| 非法 full native 开关直接调用共享门禁 | 验证配置后再执行检查 | 非零退出且无检查/记录 | 不把错误配置静默解释为跳过 | 稳定诊断码回归 |

这些路径沿用现有串行门禁、共享锁及信号监督器，不新增并发或恢复状态；
native 压力测量仍按需运行。上述范围合并、快慢路径、失败阻断和配置隔离
均已通过定向回归及 `npm test -- scripts`；实际提交/推送的完整门禁和 native
执行结果记录在 PR #604 的验证记录中。该文档及 AGENTS 的规则同步经过结构化
检查，无另设自动化文档行为检查。

本轮验证（2026-10-18，Node 24.18.0、Xcode 27.0 / SDK 27.0）：

- `npm test -- scripts`：18 文件、418 测试通过，覆盖矩阵中的推送范围、提交入口、原生选择与失败透传。
- `sh scripts/test-native.sh`：通过；Swift Testing 汇总为 288 tests / 63 suites，105.027 秒，上述五个压力方法明确跳过。
- 环境开关的真实宿主探针先复现旧传递方式无效，再以 `TEST_RUNNER_PLOTWEAVE_NATIVE_STRESS_TESTS=1` 通过；一次性探针验证后删除。永久 Swift 测试覆盖缺省、非法值和精确值 `1`，入口测试验证显式模式覆盖外部相反值。
- `sh scripts/check-static.sh`、`npx prettier --check .github`、受影响 shell 文件的 `sh -n` 与 `git diff --check` 通过。
- 文档按范围、命令及交叉引用进行结构化审查，无专用文档自动化检查。构建输出在验证后删除。
- 本轮未重复运行高负载测量；未执行真实前端/Rust 全量覆盖率、Sonar 或托管 CI。脚本测试在真实隔离 Git 仓库执行，覆盖率工具与 Sonar 网络边界使用受控替身，不能据此宣称真实 Quality Gate 或托管 CI 已通过。

### Native Regression And Stress

所有者在 [PR #604](https://github.com/hailingu/PlotWeave/pull/604)（2026-10-18）
明确选择降低默认 native 测试负载：日常回归保留，压力测试按需运行。
CI 和 native 推送门禁统一使用 `sh scripts/test-native.sh`，先构建画布，
再串行运行功能回归；原有测试失败退出码原样透传，不截断或过滤日志。

入口的选择契约为：默认向 Xcode 显式传入环境变量
`TEST_RUNNER_PLOTWEAVE_NATIVE_STRESS_TESTS=0`；Xcode 去掉 `TEST_RUNNER_`
前缀后把该值转发给测试宿主（[Apple 环境变量说明](https://developer.apple.com/documentation/xcode/environment-variable-reference)），
以下五个方法通过 Swift Testing 的 `.enabled` 条件跳过。
开关未设置或不是精确值 `1` 时同样跳过：

- `WebCanvasPerformanceTests/sustainedScriptedOperationsMatchFixtureScale(scale:)`
- `WebCanvasPerformanceTests/commonModeSupportsTauriBaselineComparison(scale:)`
- `WebCanvasPerformanceTests/repeatedHostedCanvasCyclesKeepTotalMemoryBounded()`
- `WebCanvasPerformanceTests/repeatedReloadsRecordLongMemoryTrend()`
- `WebCanvasFirstDragLatencyTests/sameNodeFirstAndSecondDragRecordStartupEvidence()`

`sh scripts/test-native.sh stress` 传入环境变量 `TEST_RUNNER_PLOTWEAVE_NATIVE_STRESS_TESTS=1`，
通过 `-only-testing` 选择整个 `WebCanvasPerformanceTests` 套件与首拖测量；
套件内三个轻量报告校验也保留。采用套件选择是因为实测 Xcode 27 的方法级
筛选未匹配两个参数化测量；启用条件由 Swift Testing 自身执行，避免默认
门禁因筛选标识未匹配而意外跑压力测试。

这将六组 100/500/1000 节点持续交互、五次窗口重建、100 次 reload 和首拖
对照测量移出默认门禁，原来的规模、等待、断言与证据口径保留。
报告格式/缺失采样校验、延迟投影下的节点级联，以及其余功能、生命周期、
存储与恢复测试继续默认运行。直接执行 `xcodebuild test` 同样默认跳过
压力测量；需要整个目标加压力测试时，在完整 Xcode 命令前显式设置
`TEST_RUNNER_PLOTWEAVE_NATIVE_STRESS_TESTS=1`。
降低负载不代表 IOSurface 报错根因已经修复，也不以日志行数承诺耗时降幅。

正常回归现在通过 `-enableCodeCoverage YES` 采集覆盖率，成功生成 JSON、Markdown 和原始 xccov 报告；显式 stress 使用 `-enableCodeCoverage NO`，避免 instrumentation 改变性能测量。构建并行预算沿用 `PLOTWEAVE_GATE_CPU_BUDGET`，缺省固定为 4；测试仍串行。详见 [Native Coverage](native-coverage.md)。

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
  file anywhere in the repository. Vitest can discover tests outside the
  maintained source trees, and their imports can read helpers or fixtures
  with any extension; a directory or test-suffix allowlist cannot establish
  input equality (PR #442 review 5361127076). Untracked documentation also
  triggers isolation; ignored generated artifacts retain the existing fast
  path behavior.
  For a `full`-scope push the gate runs fresh frontend/Rust coverage and native functional regression before Sonar; the scoped routes above select a single stack.
- **Slow path — temporary worktree.** Every other commit — a non-checked-out
  ref, a dirty worktree, or an additional distinct commit in a multi-ref
  push — is checked out with
  `git worktree add --detach` into a `mktemp` directory, dependencies are
  installed from that tree's lockfiles (`npm ci`), and the **current**
  gate scripts run the complete sequence with
  `PLOTWEAVE_GATE_REPOSITORY_ROOT` pointing at that worktree. The user's
  working tree is never touched by the slow path; the temporary worktree is
  removed after the
  run (best-effort `git worktree remove --force` on every exit path;
  residue is disk waste only, `git worktree prune` recovers it). The
  fast/slow choice is made **per unique pushed commit**, not per
  invocation: a multi-ref push that includes `HEAD` still gates `HEAD` in
  the current working tree — writing the same gitignored coverage, scanner,
  and Cargo artifacts every commit gate writes — and gates every other
  commit in its own temporary worktree; the mixed-dispatch case is pinned
  by the `pre-push-refs` multi-ref test.
- **Dedup and deletions.** Refs pointing at the same commit (a branch and
  its tag) are analyzed once; a ref deletion (all-zero local sha) exports no
  code and is skipped; a malformed ref line or a local sha that does not
  peel to a commit fails closed. A final stdin line missing its terminating
  newline also fails closed (issue #464): the dispatch loop's last `read`
  returns non-zero without running the body yet leaves the line's fields in
  the variables, so the residue is detected after the loop and rejected with
  a diagnostic naming the skipped ref. Real Git terminates every line, so
  this only fires for manual or wrapped invocations; a residue with no
  fields (whitespace only) is skipped with the same treatment as a blank
  terminated line, because a field-less line carries no ref record. Every
  ref line is analyzed or rejected — none is silently ignored.
- **Evidence and serialization.** Slow-path runs write their gate-history
  record through the main worktree's pending file and take the main
  worktree's gate lock, so fast path, slow path, and `materialize` stay
  serialized on one mutex and the record's `tree`/`head` are the pushed
  commit's (issue #355 semantics unchanged). All refs must pass before
  `materialize` runs; a failure blocks the push with earlier passing records
  left pending for the next successful push.
- **Original object identity.** The hook exports `GIT_NO_REPLACE_OBJECTS=1`
  before any Git command. Resolution (including annotated-tag peeling),
  fast-path comparisons, temporary checkout, and descendant gate records
  all read the original objects that push transfers. Local replacement refs
  remain installed; a working tree already materialized from a replacement
  fails the raw-object equality check and takes the slow path. This follows
  [Git's replacement-object semantics](https://git-scm.com/docs/git-replace)
  and closes the new trigger in
  [PR #442 review 5361127076](https://github.com/hailingu/PlotWeave/pull/442#pullrequestreview-5361127076).

**Review regression matrix (PR #442 review 5361127076).** `pre-push` owns
object resolution and dispatch; the gate owns the recorded tree and HEAD.
The tests run real Git, worktrees, hooks, and ledger writes; dependency,
coverage, and remote Sonar commands use the existing controlled substitutes.

| State and transition | Observable result and invariant | Verification in `scripts/pre-push-refs.test.ts` |
| --- | --- | --- |
| Non-HEAD pushed commit has a replacement → push | Scanner tree and ledger equal the original tree; remote receives the original SHA | Replacement-object non-checked-out test |
| HEAD's replacement content is already checked out → push | Slow path analyzes the original tree; local replacement content is preserved | Replacement-content HEAD test |
| Clean original HEAD has a replacement ref → push | Original tree remains eligible for the fast path | Clean HEAD replacement-ref test |
| Untracked nested test, imported fixture, or document → push | Slow path excludes the local input; local file remains intact and worktree is cleaned | Parameterized untracked-input tests |
| Slow-path gate fails → push | Push is blocked, remote ref is absent, and temporary worktree is removed | Existing slow-path failure test |
| Outer slow-path gate exports its root → nested test sandbox runs hooks | Each sandbox analyzes and records its own tree; outer gate root cannot leak into it | Root-isolation regressions in pre-push-refs and gate-tree-marker suites |

The first real slow-path push of this review fix exposed root-override
inheritance in those two test fixtures: four tests failed, so the hook
blocked the push. Their scenario environments must explicitly bind the
gate root to their own sandbox; production slow-path subprocesses continue
to override it with the actual pushed commit's temporary worktree.

Annotated tags use the same disabled-replacement resolution and retain the
existing branch-plus-tag regression. Separate tag-, tree-, and blob-object
replacement fixtures remain unverified: they share the process-wide Git
switch rather than a distinct dispatch branch. Concurrency and retry
ordering are unchanged; existing gate-history tests cover the shared lock.
The standalone Vitest `list --filesOnly` probe also confirmed that the
repository's actual configuration discovers `tests/boost.test.ts`; the
isolation tests verify scanner inputs rather than a coverage-inflation
percentage. No live Sonar scan is asserted by this regression suite.

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
definition of the current working tree (scope-routing rule; `full` remains the complete gate), so a pushed tree
older than the tooling itself fails closed if it lacks `package-lock.json`
(`npm ci`) or the files the gate needs; pushing such an ancient tree requires
checking it out first. Using `--no-verify` on the push remains prohibited and
is unaffected by this wiring.

The measured cost of both paths is recorded in
[Measured Baseline](quality-gate-cost.md#measured-baseline): the fast path is the unchanged
complete-gate cost (the refreshed baseline measures it); the slow path adds
dependency installation and cold caches and was measured once on landing —
see
[Push-Path Slow-Path Cost](quality-gate-cost.md#push-path-slow-path-cost-2026-09-30-issue-405).
Whether the fast path is reachable in daily workflow — and how to restore
it — is recorded in
[快路径可达性与恢复条件](#快路径可达性与恢复条件issue-463) below.

## 快路径可达性与恢复条件（issue #463）

[issue #463](https://github.com/hailingu/PlotWeave/issues/463) 记录了一项
已知交互：快路径的合取前提在日常推送工作流下几乎必然不成立，慢路径因此
成为实际默认，而[决策正文](quality-gate-cost.md#push-path-slow-path-cost-2026-09-30-issue-405)
的快/慢成本对比此前没有说明这一可达性前提。这不是任一特性的实现缺陷，
分派严格性也不因此放宽——它对覆盖率的正确性是必需的（Vitest 可发现任意
目录内的测试与夹具，未跟踪输入必须隔离）。此处记录因果、恢复条件，并让
慢路径启动时输出触发原因。

快路径要求同时满足三个前提：

1. 被推提交（本地 sha peel 到的提交）就是当前 `HEAD`；
2. `git diff --quiet HEAD --` 与 `git diff --cached --quiet HEAD --` 均
   无差异——被跟踪内容的工作树与索引都与 `HEAD` 一致（保证台账
   `tree` 键与被推提交同源）；
3. 整个仓库没有未忽略的未跟踪文件。

历史上推送自身是快路径的一个必然失效来源：issue #355 起 `pre-push`
在门禁通过后把待物化记录并入被跟踪的 `docs/development/gate-history.jsonl`
（保持未暂存），每次成功推送后工作树必然带有被跟踪差异，下一次推送随之
降级慢路径。PR #581 评审 5537970549 起 **推送不再物化**：推送产生的记录
留在 `.git` 内待物化文件，由下一次提交创建钩子（pre-commit /
pre-merge-commit 的 `materialize --stage-for-commit`）按待物化内容字节
精确归因后折并暂存——推送不触碰被跟踪文件，工作树保持干净，该失效来源
消失；人工对台账的未暂存改动仍会按既有规则使快路径不可达（本属被跟踪
差异的常规语义），此时钩子只警告不自动暂存。剩余的独立失效来源：

- **未跟踪的普通文件。** 草稿、新文档、临时笔记等任何未忽略的未跟踪文
  件都会取消快路径资格，与被跟踪差异无关；这是输入等价性证明的要求，
  不能按目录或后缀放宽。

恢复快路径的操作条件：使仓库内没有长期滞留的未忽略未跟踪文件（提交、
加入忽略规则或移除）且被跟踪内容与 `HEAD` 一致；此后推送 `HEAD` 即恢复
当前工作树快路径。门禁强度与快/慢判定不因此变化——本节只记录可达性与
诊断。

慢路径启动前输出首个不成立的快路径前提，使慢路径成本来源当场可见（仅推
送包含非删除 ref 时；纯删除推送不触发门禁与该输出）。以下是分派原因的
稳定诊断代码契约（中文解释可调整）：

| 代码 | 条件 |
| --- | --- |
| `PRE_PUSH_SLOW_NOT_HEAD` | 被推提交不是当前 `HEAD` |
| `PRE_PUSH_SLOW_TRACKED_DIRTY` | 工作树被跟踪内容与 `HEAD` 有差异 |
| `PRE_PUSH_SLOW_INDEX_DIRTY` | 索引内容与 `HEAD` 有差异 |
| `PRE_PUSH_SLOW_UNTRACKED_INPUT` | 仓库内存在未忽略的未跟踪文件 |
| `PRE_PUSH_SLOW_UNTRACKED_ENUM_FAILED` | 无法枚举未跟踪文件（fail-closed 慢路径） |

## 平台支持范围与依赖进程契约（issue #503）

**处置日期：2026-10-03。** [issue #503](https://github.com/hailingu/PlotWeave/issues/503)
的两项行为变化按显式契约登记，保留 #462/#465 的监督语义。

### 平台支持范围

PlotWeave 当前支持 **macOS**，**不支持 Windows**；范围包括应用运行、开发工具链、
提交/推送门禁与发行，而非仅某个安装脚本的限制。构建与 CI 只在 macOS 上验证；
Linux 无本仓库构建与测试覆盖，Unix 进程组能力本身不构成平台支持承诺。

安装期限配置有效时，Windows 上触发慢路径的推送会在安装监督器处以
`PRE_PUSH_INSTALL_PLATFORM_UNSUPPORTED` 非零退出，阻止后续门禁及推送，
由钩子清理临时 worktree。安装期限校验先于平台检查：若
`PLOTWEAVE_NPM_INSTALL_TIMEOUT` 无效，则先以
`PRE_PUSH_INSTALL_TIMEOUT_INVALID` 非零退出，不再报告平台诊断；同样不启动
安装，阻止后续门禁与推送，并由钩子清理临时 worktree。
干净 HEAD 等条件仍按原判定允许快路径分派，
但未触发监督器不代表 Windows 获得支持，也不保证其完整门禁可运行。
贡献者须换到受支持的 macOS 环境执行完整门禁并推送，不得绕过钩子。
Windows 没有构建或行为验证路径；未来若改变支持范围，须另行获得所有者
授权并补齐该平台构建、测试与门禁验证。

### 依赖 lifecycle 的进程约束

慢路径仍执行完整 `npm ci`（含根包和依赖包的 lifecycle 脚本）。
**安装完成后，同组遗留后代一律进入终止清理**，无论 npm 成功或失败退出，
也不区分后代是否由依赖主动作为后台服务启动。监督器先发送 TERM，
1 秒后发送 KILL；若 TERM 已报告 ESRCH，则确认组不存在并停止后续信号。
清理结束后保留 npm 的退出结果；中断或非 ESRCH 的清理错误仍阻止成功。
这约束进程生存期，不删除安装结果或改变依赖生成文件的构建语义。

因此，根包和依赖的安装脚本必须在结束前完成工作并收尾子进程，不得依赖
同组后台服务在安装返回后继续运行，也不得依赖它为后续测试、构建或扫描
提供服务。需要持续服务的开发流程须在安装与门禁之外显式启动和管理其
生命周期；主动脱离进程组不属于清理保证，也不是规避该依赖约束的方式。

两个 Sonar 令牌仍从安装环境删除，安装死线与 TERM → 宽限 → KILL 的
顺序保持原契约。`PRE_PUSH_INSTALL_TIMEOUT` 的超时诊断及推送钩子
`PRE_PUSH_LEFTOVER_GROUP` 的组长未退出诊断保留，快/慢路径判定不变。
既有 `scripts/pre-push-install.test.ts` 覆盖真实同组后代在成功、失败、
中断及清理错误下的结果；`scripts/pre-push-refs.test.ts` 覆盖真实零依赖
`npm ci`、凭据隔离、超时及逐 ref 分派。本处选择 issue 允许的显式依赖
契约，不新增真实依赖遗留服务的兼容性夹具，也不声称已验证该兼容性。

## 独立安装期限（issue #497）

[issue #497](https://github.com/hailingu/PlotWeave/issues/497) 的修复将安装期限
交给独立进程组中的 watchdog。安装 launcher 与 watchdog 是监督器的两个
子进程，npm 及 lifecycle 只在 watchdog 就绪后启动，并继承 launcher 的
进程组。因此 lifecycle 挂起其祖先监督器不会冻结 watchdog 的计时器，
watchdog 也不依赖监督器回调来获得安装组号。

期限到达时，watchdog 输出 `PRE_PUSH_INSTALL_TIMEOUT`，直接对安装组发送
TERM，1 秒后升级 KILL，并终止监督器，使钩子的 wait 非零返回。正常完成、
失败或中断仍由监督器执行既有组清理；进入清理时将安装期限切换为 2 秒的
清理兜底，完成后撤销 watchdog 并等待其退出，才返回安装结果。
启动失败或 watchdog 提前异常退出以 `PRE_PUSH_INSTALL_WATCHDOG_FAILED`
阻止安装成功。监督器确认组不存在后会通知 watchdog 撤销该组的后续信号，
监督器自身的限期退出仍保留。

| 前置状态与动作（含顺序） | 预期可观察结果 | 跨转换不变量及责任入口 | 对应验证 |
| --- | --- | --- | --- |
| launcher 创建 → watchdog 就绪 → npm 启动 | 安装开始前已有独立期限与安装组标识 | 监督器启动入口：未建立外部监督不得执行 lifecycle | watchdog 启动失败与既有启动窗口信号回归 |
| lifecycle 及后代就绪 → SIGSTOP 监督器 → 安装期限到达 | 超时诊断、安装组和监督器结束、推送失败、无扫描或远端 ref、临时树移除 | watchdog 期限入口及 pre-push：监督器挂起不解除期限与资源清理 | 独立监督器 SIGSTOP 回归；真实 npm ci 推送回归 |
| npm 正常或非零退出 → TERM/KILL 后代清理 → 撤销 watchdog | 保留原退出结果，watchdog 退出后才完成 | 监督器 close/finish：所有完成路径清理后代；撤销后不得向旧组号继续发信号 | 既有 0/7 后代清理、ESRCH 与延迟 close 回归 |
| 监督器确认安装组 ESRCH → 通知 watchdog → close 延迟跨过清理期限 | 不再向旧组号发信号；监督器仍限期失败退出 | 两个清理入口：共享已不存在状态，不因外部兜底重启组清理 | watchdog 真实 IPC 与组号复用哨兵回归 |
| INT/TERM/HUP 或期限与 close 交错 → 清理 | 中断或超时保持失败，清理收敛；门禁锁保护不变 | 监督器 stop/interrupt、watchdog 与钩子信号入口：失败不得被成功覆盖 | 既有三个信号、清理期间中断及门禁组长存活回归 |
| 无效期限、npm 启动失败或 watchdog 不可用 → 请求安装 | 非零退出，不进入门禁；已创建的安装组被清理 | 监督器启动/错误入口：监督缺失不得退化为无限期安装 | 无效配置、npm/watchdog 启动失败回归 |

同一用户身份的 lifecycle 仍可主动寻找并挂起或杀死 watchdog、钩子等其他
进程；这不是操作系统级隔离。独立期限保证以 watchdog 继续获得调度为前提，
覆盖本 issue 的祖先监督器被挂起路径。主动脱离安装组的后代仍是既有清理
边界。未新增自动重试、并发安装或 Windows 支持；网络与 lifecycle 共用
该期限，离线测试不连接真实 registry。`.npmrc`、lifecycle 与 Sonar 令牌
清理契约保持原行为。

2026-10-04 验证：2 秒期限下，修复前真实 SIGSTOP 令监督器在 5 秒后仍未
结束；修复后独立安装回归及真实 npm ci 推送用例均通过。后者在 prepare
中挂起祖先监督器，验证超时诊断、安装组和监督器结束、无扫描或远端 ref、
临时树移除。组号复用探针验证 absent 在清理兜底前、TERM 后、释放及失联
入口均生效；真实监督器连线测试暂时移除通知时哨兵被终止，恢复后通过。
该探针在真实 ESRCH 后映射旧组号的信号目标，不声称迫使内核实际复用组号。
未单独注入安装开始后 watchdog 异常退出，也未穷举释放、期限和中断的全部
排列；启动失败与既有停止入口覆盖共用的失败关闭、幂等清理和失败结果保护。

## 安装与凭据状态矩阵（issue #462）

[issue #462](https://github.com/hailingu/PlotWeave/issues/462) 的实现：
`pre-push` 负责安装的期限、失败分派及临时树清理；安装执行器负责子进程组
及安装环境；`sonar-quality-gate.sh` 负责认证令牌的使用阶段。安装仍执行
真实 `npm ci`，不通过跳过 lifecycle 脚本改变依赖构建行为。

| 前置状态与动作（含顺序） | 预期可观察结果 | 跨转换不变量及责任入口 | 对应验证 |
| --- | --- | --- | --- |
| 调用者同时设置两个令牌 → 非检出 ref 安装 → 检查 → 扫描 | 真实 prepare 的直接环境读不到两个变量；扫描器和 API 仍可认证 | 安装执行器及统一门禁：被分析代码的直接继承环境不含两个 Sonar 令牌；扫描对象保持被推提交 | pre-push 真实零依赖 npm ci 探针；统一门禁环境探针；既有认证优先级测试 |
| 调用者已导出小写 sonar_token → 保存主令牌或备用令牌 → 检查/覆盖率 → 扫描 | 检查和覆盖率环境不含保存的凭据，扫描器/API 使用所选令牌 | 统一门禁：内部保存变量不得因继承导出属性而泄漏凭据，认证优先级不变 | 统一门禁主令牌/备用令牌导出属性回归 |
| 安装正常结束 → 完整门禁 → 推送 | 远端收到该 SHA，台账绑定该树，临时树移除 | pre-push：安装成功不代替任何门禁步骤，也不修改用户工作树 | 真实 npm ci 成功探针及既有逐 ref 套件 |
| npm 安装非零退出 → 阻止推送 | 保留安装错误，扫描未执行，远端 ref 不存在，临时树移除 | pre-push：未完成安装不得进入门禁或推送 | 安装失败回归 |
| npm 无法启动 → 安装结束 | 立即报告启动失败，不伪装为超时 | 安装执行器：未启动安装不得报告成功 | pre-push-install 启动失败回归 |
| npm 以 0 或非零退出，但同组后台后代忽略 TERM → 完成清理 | 先 TERM、1 秒后 KILL；后代结束后才保留 npm 成功或失败结果 | 安装执行器 close 入口：任何安装完成路径都不得提前解除后代监督 | pre-push-install 正常/失败完成后代回归 |
| 启动前注册 INT/TERM/HUP → spawn 创建进程组且尚未返回时收到信号 | supervisor 保持存活并执行有界清理，返回失败 | 安装执行器启动入口：从创建受监督进程组起，中断处理始终有效 | pre-push-install 启动窗口真实信号回归 |
| npm 成功退出 → 清理后台后代期间收到中断 | 仍完成清理，但最终返回失败 | 安装执行器 interrupt/close 入口：成功不得覆盖已收到的中断 | pre-push-install 完成清理期间中断回归 |
| npm 成功退出 → TERM 或 KILL 发送出现非 ESRCH 错误 | 保留清理错误诊断并返回失败；TERM 失败仍尝试 KILL | 安装执行器：任何清理错误均阻止成功，后续信号成功不得覆盖失败状态 | pre-push-install TERM/KILL 错误注入回归 |
| npm 以 0 或非零退出且进程组已不存在 → TERM 收到 ESRCH | 保留原退出结果，不再安排 KILL，不影响复用组号的其他进程 | 安装执行器 close/stop 入口：确认组不存在后不得继续向该组号发信号 | pre-push-install 真实 ESRCH 与组号复用边界回归；既有真实 npm ci 成功探针 |
| npm 已退出但 close 尚未回调 → 中断或超时 → TERM 收到 ESRCH → close | 不再安排组 KILL，在清理兜底期限内等待 close 后返回失败，未收敛则终止监督器（#497） | 安装执行器 interrupt/deadline/close 入口：组消失不能覆盖失败结果，也不能重新启动组清理 | pre-push-install 延迟 close 的中断/超时回归；#497 真实通知连线回归 |
| 安装及后代已就绪 → 执行器收到 INT/TERM/HUP（含终端断开）→ 有界清理 | 报告中断；先 TERM、1 秒后 KILL，进程组结束并返回失败 | 安装执行器：各中断入口均保留有界清理，不因 supervisor 退出而遗留受监督安装进程 | pre-push-install 真实 INT/TERM/HUP 信号回归与后代存活探针 |
| 安装超过期限（lifecycle 与其子进程忽略 TERM）→ 强制终止 → 阻止推送 | 超时诊断；进程组结束；扫描未执行；临时树移除 | 安装执行器与 pre-push：失败路径有界终止并清理资源 | 真实 npm ci 超时及子进程存活探针 |
| 超时配置无效 → 请求慢路径安装 | 配置诊断，安装和扫描均未启动 | 安装执行器：无效期限不得退化为无期限执行 | 参数化无效配置回归 |
| 干净 HEAD、混合 refs、标签、删除 ref → 推送 | 原有快慢分派与去重语义保持 | pre-push：逐唯一被推提交执行完整门禁 | 既有快慢路径、多 ref、标签、删除及替换对象套件 |

并发安装不由此修复引入；原有门禁锁仍串行化分析和台账写入。没有自动安装
重试，失败后用户重新执行推送会创建新的临时树。网络 registry 挂起与
lifecycle 挂起共用同一安装期限（独立 watchdog 的调度前提见 issue #497）；
测试使用离线零依赖包，不连接外部 registry。
真实 Sonar 门禁由提交和推送验证，测试沙箱不访问真实服务。

2026-10-02 验证：修复前观察到真实 prepare 的两个令牌均可见、超时设置不
阻止推送及统一门禁向检查/覆盖率暴露令牌；修复后新增 11 项回归通过，原有
逐 ref 与门禁脚本套件通过。默认沙箱禁止 `ps` 与主仓库 `.git` 写入时，既有
进程身份/台账测试失败；在允许这些本地验证操作的环境中重跑通过，未放宽门禁。
网络挂起未连接真实 registry 注入（与 lifecycle 共用期限），Windows 和主动
脱离进程组的后代未验证；前者明确拒绝，后者保留为清理边界。

2026-10-02 的 [PR #481 评审 4162509562](https://github.com/hailingu/PlotWeave/pull/481#discussion_r4162509562)
补齐 HUP 中断入口：修复前真实 SIGHUP 使 supervisor 被信号直接终止，未返回
清理后的失败状态；修复后与 INT/TERM 共用已有中断处理。安装执行器的 4 项
回归通过，三个信号均验证忽略 TERM 的安装进程及其后代结束。信号在后代就绪
后直接注入 supervisor，未实际关闭终端或 SSH 会话；重复信号与超时竞态沿用
已有 `stopping` 保护，本轮未另行注入该竞态。启动失败、普通安装失败、期限
与无效配置继续由既有套件覆盖，没有新增并发、重试或独立清理路径。

2026-10-02 的 [PR #481 评审 5388048292](https://github.com/hailingu/PlotWeave/pull/481#pullrequestreview-5388048292)
补齐正常完成后的后代清理及启动信号保护。修复前，npm 以 0 或 7 退出后
同组后台后代仍存活；在真实 spawn 创建进程组、尚未返回的窗口注入三个
信号，supervisor 均被默认信号处理终止。修复后先注册中断监听器，再创建
安装组；npm 的所有退出路径均完成 TERM/KILL 清理后返回原退出结果，清理
期间收到中断则改为失败。启动失败的 error/close 顺序只完成一次，不额外
等待清理期限。安装执行器的 10 项回归通过，包含上述六项新增用例；既有
启动失败用例将等待上限收紧到 1 秒，验证无效可执行文件立即失败。

启动窗口探针以测试 preload 包装真实 spawn，在返回前向 supervisor
发送真实信号并暂停 200 毫秒；没有在生产代码增加测试入口，也不以监听器
数量或源码布局作为断言。正常/失败完成探针验证忽略 TERM 的真实后台
后代结束；清理期间中断用例验证失败结果和后代结束。未注入重复信号与
超时同时到达的所有排列；三个入口共用幂等的停止状态，首次停止清除
安装期限，后续中断仍覆盖成功结果。未扩展 Windows 或主动脱离组的清理边界。

2026-10-02 的 [PR #481 评审 5388294197](https://github.com/hailingu/PlotWeave/pull/481#pullrequestreview-5388294197)
补齐凭据保存变量的导出属性和清理失败结果。修复前，已导出的 `sonar_token`
被重新赋值后仍将主令牌或备用令牌传给检查、前端覆盖率和 Rust 覆盖率子进程；
修复先 unset 同名变量，再保存所选凭据。真实 shell 回归分别验证主令牌与
备用令牌不会直接下发，扫描器和 API 仍使用正确认证。

安装清理信号遇到非 ESRCH 错误时，现在将结果保持为失败，TERM 失败后仍
尝试 KILL。修复前，两种信号的 EPERM 注入均返回成功；修复后的回归验证
失败码和清理诊断，以及 TERM 失败后由 KILL 结束真实后代。KILL 被拒绝时
测试明确观察到后代仍存活，由测试自身清理；失败结果不代表操作系统已允许
终止该后代。本轮只在 supervisor 的系统调用边界注入权限错误，未通过真实
跨 UID 进程制造 EPERM。已不存在的进程组仍视为清理完成；正常安装、启动
失败、超时和中断继续由既有回归覆盖。本轮四项新增回归及完整脚本套件
226 项均通过。

2026-10-02 的 [PR #481 评审 5388443757](https://github.com/hailingu/PlotWeave/pull/481#pullrequestreview-5388443757)
区分 TERM 已发送与进程组已不存在。TERM 返回 ESRCH 后立即结束信号清理，
不再安排一秒后的 KILL；npm 的 close 已到达时保留退出码，尚未到达时等待
close，并保留中断或超时造成的失败。TERM 发送成功或遇到非 ESRCH 错误时，
仍沿用已有升级清理及失败规则。
issue #497 在此基础上增加独立清理兜底：仅在该期限内等待尚未到达的 close，
未收敛则失败终止监督器；已确认消失的安装组不再参与外部升级信号。

四项回归覆盖正常退出、非零退出，以及 close 前中断/超时：真实 npm 替身
退出后观察真实 ESRCH，再把针对旧组号的后续信号映射到独立测试进程组，
验证该组继续存活。修复前四例均因该测试进程被终止而失败；修复后均通过。
中断/超时用例以测试 preload 延迟 close 回调，未改变生产执行入口。这里
模拟组号复用后的信号目标，未用高频创建进程迫使操作系统实际复用组号；
本次保证限于观察到 ESRCH 后不再发信号，不声称消除尚未观察到组消失时的
所有 PID 复用窗口。已有真实后代、权限错误、启动失败和各信号入口回归
继续验证相邻转换。

### 安装执行与认证边界

慢路径仍以调用者身份执行被推树的 `npm ci`，包括根包和依赖包的 lifecycle
脚本；该树的 `.npmrc` 可以改变 registry 等项目级 npm 配置。
`scripts/pre-push-install.mjs` 在子进程环境中删除 `SONAR_TOKEN` 与
`PLOTWEAVE_SONAR_TOKEN`，统一门禁也在静态检查、前端覆盖率和 Rust 构建之前
删除两个变量。在统一门禁进程内部，先 unset 小写 `sonar_token` 以清除继承的
导出属性，再把认证值保存在该非导出变量中；扫描器调用局部设置
`SONAR_TOKEN`，API 认证经 curl 标准输入传入；优先级与认证行为保持原有契约。

这只阻止两个 Sonar 环境变量向被分析子进程传递，不提供针对恶意提交的操作系统沙箱：执行代码
仍具有当前用户的文件、网络访问权限和其他继承环境，可能读取用户 npm 配置
或其他凭据。跨进程凭据隔离的限制登记在[不可实现的边界](#不可实现的边界同用户代码与调用者凭据隔离)。
推送他人或来源不可信的提交前仍应审查其安装、测试与构建代码。
保留 lifecycle 是为了维持 esbuild 等依赖的安装构建语义，本修复未启用
`--ignore-scripts`，也未覆盖被推树的 npm 配置。

安装期限默认 **300 秒**，可通过 `PLOTWEAVE_NPM_INSTALL_TIMEOUT` 设置
**1..2147483 的整数秒**（上限使 Node 定时器不会溢出而退化）。从启动 npm
到安装结束共享同一期限，网络和 lifecycle 均计入；到期先向安装进程组发
TERM，**1 秒**后发 KILL，并等待 npm 结束，再以失败返回。收到 INT、TERM
或终端断开的 HUP 时，也执行同样的有界进程组清理；这些监听器在 spawn
之前注册。npm 正常或非零退出后也先 TERM、1 秒后 KILL 剩余同组后代，再
保留 npm 退出结果；这最多增加 1 秒清理等待，清理期间的中断仍使结果失败。
TERM 或 KILL 发送出现非 ESRCH 错误也使结果失败，后续发送成功不会恢复成功
状态；ESRCH 表示组已不存在。TERM 返回 ESRCH 时不安排后续 KILL，不再向
该组号发信号；npm 的 close 尚未到达时仍等待它，并保留已有失败状态。
权限错误可能使后代仍存活，失败诊断不承诺清理完成。
无法启动 npm 时立即失败，不启动后代清理定时器。普通安装失败、超时或
无效配置均阻止后续门禁和推送，钩子的
退出清理移除临时 worktree。此监督依赖 Unix 进程组，Windows 慢路径明确失败；
平台支持范围与依赖进程约束见[issue #503 契约](#平台支持范围与依赖进程契约issue-503)，
主动脱离进程组的后代不在清理保证之内。
此期限仅约束安装，不是整个门禁的总期限；扫描器仍使用既有的
`SONAR_QUALITY_GATE_TIMEOUT`，检查和覆盖率没有新增超时或步骤缩减。

以下是安装执行器的稳定诊断代码契约，中文解释可调整：

| 代码 | 条件 |
| --- | --- |
| `PRE_PUSH_INSTALL_TIMEOUT` | 安装超过配置期限，或正常收尾未在清理兜底期限内结束 |
| `PRE_PUSH_INSTALL_TIMEOUT_INVALID` | 安装期限非合法整数或超出范围 |
| `PRE_PUSH_INSTALL_FAILED` | npm 非零退出或被信号终止 |
| `PRE_PUSH_INSTALL_START_FAILED` | npm 无法启动 |
| `PRE_PUSH_INSTALL_INTERRUPTED` | 执行器收到 INT、TERM 或 HUP |
| `PRE_PUSH_INSTALL_WATCHDOG_FAILED` | 独立期限进程启动、IPC 或退出异常；安装失败关闭 |
| `PRE_PUSH_INSTALL_CLEANUP_FAILED` | 进程组信号发送失败，除已不存在的组；阻止安装报告成功 |
| `PRE_PUSH_INSTALL_PLATFORM_UNSUPPORTED` | 平台不支持当前 Unix 清理实现 |

## 推送钩子的中断清理（issue #465）

[issue #465](https://github.com/hailingu/PlotWeave/issues/465) 记录了 #405 慢路径引入的两处退化与一处连带缺陷：安装与门禁这两类**分钟级前台子进程**使 POSIX 信号 trap 被推迟到子进程返回（专项审计实测单独向钩子发 `SIGINT` 后 18 分钟 `npm ci` 仍在运行、临时 worktree 仍登记在册）；信号路径的清理不清空登记变量，EXIT trap 随后对已移除的路径重试 `git worktree remove` 并打印与事实不符的「无法清理」警告；推送门禁持有互斥锁数分钟期间，并发 `git commit` 立即失败且文案未说明窗口时长。

实现（2026-10-02，同日按 [PR #484 评审 5389125859](https://github.com/hailingu/PlotWeave/pull/484#pullrequestreview-5389125859) 补强升级次序）分三部分，均不改变门禁强度与快/慢判定：

- **受监督运行。** `.githooks/pre-push` 的快路径门禁、慢路径安装执行器与慢路径门禁改经 `supervise_child_process` 运行：命令作为后台作业启动（临时启用作业控制使其获得独立进程组），钩子 `wait` 它完成。`wait` 可被信号打断，HUP/INT/TERM 的 trap 因此及时执行，不再受前台子进程推迟。
- **信号路径与升级次序。** trap 先向受监督进程组发 TERM，随后等待**组长**（安装执行器或门禁脚本，锁的持有者）自行退出——组长存活期间绝不向组发 KILL：那会在门禁的 `release_lock` trap 运行前杀死它、泄漏锁目录（评审指出的缺陷）。组长退出后清扫仍存活组员；宽限 10 秒后组长仍存活（如自身忽略 TERM 的病态执行）时保留其运行并输出 `PRE_PUSH_LEFTOVER_GROUP`，锁由其退出时释放。随后以 128+信号 码退出，EXIT trap 清理临时 worktree 与临时根；钩子退出非零使本次推送按钩子失败处理，不产出门禁结论。
- **门禁自身的信号清理。** `sonar-quality-gate.sh` 的四个长步骤（静态检查、前端覆盖率、Rust 覆盖率、扫描器）改 `run_step` 后台 + wait 运行，HUP/INT/TERM 的 trap 改为「先 `release_lock` 再以 128+信号 码退出」——信号到达时锁即时释放，不被忽略 TERM 的前台子进程推迟到其返回；提交/合并路径的信号同样受益。这是上一条升级次序成立的前提：钩子的 TERM 到达后，门禁组长应在秒级完成收尾退出。
- **诚实的清理警告与锁文案。** 临时 worktree 清理幂等（登记变量在首次清理时置空），目标已不存在同样视为成功，警告只在目录确实留存时出现并携带稳定代码；门禁锁获取失败的新增稳定代码说明运行中的推送门禁可持锁数分钟、期间提交被拒绝属预期（见[门禁生命周期](quality-gate-lifecycle.md#门禁锁的人工恢复issue-430)）。

| 前置状态与动作（含顺序） | 预期可观察结果 | 跨转换不变量及责任入口 | 对应验证 |
| --- | --- | --- | --- |
| 慢路径门禁悬挂（含忽略 TERM 的后代）→ 仅向钩子进程发 SIGINT | 钩子以 130 秒级退出；临时 worktree 与临时根移除；后代结束；锁释放；无残留警告 | 钩子信号入口：中断不得遗留分钟级悬挂子进程或残留临时树 | pre-push 中断回归（慢路径） |
| 快路径门禁悬挂 → 仅向钩子进程发 SIGTERM | 钩子以 143 秒级退出；后代结束；锁释放 | 同上（无临时树维度） | pre-push 中断回归（快路径） |
| 门禁前台步骤忽略 TERM 超过宽限 → 钩子信号（评审 5389125859） | 门禁组长仍先释放锁再退出（`run_step` 使 trap 即时执行）；其后代被 KILL 清扫；锁不泄漏 | 门禁信号入口：锁释放不得依赖前台子进程对 TERM 的响应 | 评审场景回归（前台忽略 TERM） |
| 受监督组长宽限期内未自行退出（自身忽略 TERM 的病态执行） | 不对组长 KILL；输出 `PRE_PUSH_LEFTOVER_GROUP`；锁保持占用至其退出 | 升级次序：强制终止不得先于锁持有者的收尾 | 组长存活回归 |
| 清理时 `git worktree remove` 报告失败但目录已被移除 | 不输出残留警告；登记清空 | 清理警告必须与实际残留一致 | removeThenLie 回归 |
| `git worktree remove` 确实失败且目录留存 | 输出恰一次 `PRE_PUSH_WORKTREE_RESIDUE`；目录保留供人工恢复 | 清理失败只浪费磁盘，不阻塞门禁结论（沿用 #405 语义） | 受控 remove 失败回归 |
| 信号 trap 清理后再走 EXIT trap | 登记已置空，二次清理为无操作 | 清理幂等 | 中断回归的警告缺席断言 |
| 门禁进程收到 TERM（仅发往门禁本身，提交路径同形态） | 门禁先释放锁再以 143 退出，不被忽略 TERM 的前台子进程推迟 | 门禁信号入口拥有锁的及时释放 | 门禁信号清理回归 |
| 推送门禁持锁运行中 → 另一 Git 操作触发门禁 | 立即失败并给出等待指引代码与残留锁恢复命令；不排队、不删他人锁 | 获取失败语义沿用 #430 fail-closed | 门禁锁等待指引回归 |

钩子级的稳定诊断代码契约（中文解释可调整）：

| 代码 | 条件 |
| --- | --- |
| `PRE_PUSH_INTERRUPTED` | 钩子收到 HUP/INT/TERM：已终止门禁子进程并进入退出清理 |
| `PRE_PUSH_WORKTREE_RESIDUE` | 临时 worktree 清理失败且目录确实留存；附 `git worktree prune` 恢复指引 |
| `PRE_PUSH_LEFTOVER_GROUP` | 受监督组长未在宽限期内自行退出；已停止强制终止，锁保持占用至其退出（PR #484 评审 5389125859） |

### 边界与未验证项

- 信号在后台作业启动与 `supervised_group_pid` 赋值之间的极窄窗口到达时，处理器看不到该子进程，它将作为孤儿继续运行：安装执行器自有期限约束，门禁子进程沿用既有退出路径并最终释放锁。该竞态窗口为微秒级，未注入验证。
- 组长存活判定用 `kill -0`：已退出组长即时失效的前提是 shell 已回收其收尸状态——bash 在事件循环中自动回收（中断回归实测组长退出即时可见）；不异步回收僵尸的 shell 可能把已退出的组长误判为存活，后果限于多输出一次 `PRE_PUSH_LEFTOVER_GROUP` 并跳过对组长已退出后残留组员的 KILL 清扫，不会误杀。
- 提交/合并路径的信号只发往门禁进程本身时，`run_step` 的步骤子进程不随门禁退出而终止，会孤儿运行至自然结束（锁已由 trap 先行释放，产物均为被忽略的扫描/覆盖率文件）；推送路径无此残留——钩子对组长退出后的组员执行 KILL 清扫。
- 真实终端 Ctrl-C 会向整个前台进程组发信号（git、钩子及无作业控制时的子进程直达），本修复的中断回归只注入了「仅钩子进程本身」的信号——它是严格更难的情形；终端路径未实测，沿用专项审计的未验证边界。
- 受监督进程组只覆盖未脱离组的后代：主动 `setsid` 的子进程（如安装执行器自己的 npm 组）不在组信号范围内，由其所属执行器的既有清理负责。KILL 清扫只保证发送，不保证操作系统对特权进程生效。
- 前台短命令（`git worktree add`、清单物化等）运行期间的信号 trap 仍推迟到该命令返回，量级为秒，未另设处理；门禁内部 `run_step` 之外的短命令（awk 摘要、curl API、node 解析）同理。
- 验证平台为 macOS 的 `/bin/sh`（bash POSIX 模式）；dash 及其他 shell 的作业控制与僵尸回收行为未验证。

### 不可实现的边界：同用户代码与调用者凭据隔离

**状态**：当前执行模型下不可实现的边界问题。仓库所有者于 2026-10-02
明确采用此登记方式；本项不作为已修复问题或等待局部补丁的缺陷。
来源为 [PR #481 评审 4162309542](https://github.com/hailingu/PlotWeave/pull/481#discussion_r4162309542)，
对应 [issue #462](https://github.com/hailingu/PlotWeave/issues/462) 的凭据执行边界。

触发前提是：被推树的 lifecycle、测试或构建代码不可信，但仍以调用者的
用户身份和资源访问权限运行；调用者的 Git、钩子或终端祖先进程携带 Sonar
认证环境；系统允许该代码检查相关同用户进程。在这些前提下，不能保证
被推树代码无法取得调用者的凭据。安装 supervisor 目前也继承两个 Sonar
变量；对子进程环境的清除不移除 supervisor 或祖先进程持有的值。

在 macOS（本项目目标平台）上，同用户祖先进程的环境可经
`ps -Eww -p <祖先进程 pid>` 读取，无需 Linux 的 `/proc`。
[issue #499](https://github.com/hailingu/PlotWeave/issues/499) 的 macOS 实测报告
在 npm 父进程、安装 supervisor 和钩子 shell 三处均检测到两个令牌变量名。
2026-10-03 的最小复核以干净环境启动父进程，只注入两个变量的合成占位值，
再启动不继承它们的子进程：子进程直接环境的两个变量均不存在，但经
`ps -Eww` 检查该父进程时两个变量名均可见；输出仅含是否存在的布尔值。
该复核验证 macOS 的祖先环境读取能力，未重跑完整推送链路或使用真实令牌。

仅以干净环境启动 supervisor 可以移除一个读取目标，但无法隔离仍持有
认证值的祖先进程或当前用户可访问的凭据资源。启动后删除 `process.env`
也不能等价替代干净启动：按照 [Linux proc_pid_environ(5)](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html)，
`/proc/<pid>/environ` 反映 `execve` 时的初始环境，后续环境修改不会更新
该文件；访问仍取决于系统的进程检查权限。

本项目可验证的保证限于：安装、检查和覆盖率子进程不继承两个 Sonar
环境变量，安装受期限约束，认证仍在扫描器与 API 使用阶段有效。
[安装与凭据状态矩阵](#安装与凭据状态矩阵issue-462)和真实 npm 探针验证这些保证，
不能作为同用户恶意代码的凭据隔离证明。[issue #462 的关闭说明](https://github.com/hailingu/PlotWeave/issues/462#issuecomment-5946205830)
中的环境清理保证也按此直接继承范围理解，不表示祖先进程中的凭据不可读。
macOS 的读取能力已有上述实测；Linux `/proc` 变体未实测，仍按系统文档
登记，不声称已完成跨平台攻击验证。本次文档修正保持该项为已披露残余，
不改变直接环境清理、安装期限或认证行为。

“不可实现”限定于上述执行模型和局部环境清理措施。要提供跨进程凭据隔离，
必须改变代码执行与凭据访问的信任边界，例如建立独立权限域或受约束的
凭据代理；项目尚未实现或验证此类架构。本次只登记边界，不修改运行代码
或门禁步骤；重新设计需要另行由仓库所有者授权。

## Known Finding: Push Scans The Checked-Out Tree, Not The Pushed Ref

**Update 2026-09-30 (issue #405 fix)**: this finding is closed. `.githooks/
pre-push` now reads the refs Git hands it on stdin and gates every pushed
ref at that ref's commit state — in the current working tree only when it is
provably identical to the pushed commit, otherwise in a temporary worktree
checked out at that commit (see
[Push-Path Per-Ref Gating](#push-path-per-ref-gating-issue-405)). The
equality proof covers tracked differences (staged and unstaged) and
untracked non-ignored files anywhere in the repository; ignored inputs and
differences hidden by `skip-worktree` /
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
[implemented per-ref remedy](#push-path-per-ref-gating-issue-405) can close this one.

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
OID while `HEAD` was the different rejoin merge commit (评审 4115812068).
Since issue #404, the wired `pre-merge-commit` gates that rejoin merge after
the earlier rejoin supplied subtree metadata, with same-operation tree-marker
dedup in `prepare-commit-msg`; the recheck above confirms this also holds
with `--squash` when that metadata is present.
`reference-transaction` remains unwired and split generation has no
commit-creation hook. The #405 wrong-tree scan described here is the
pre-fix measurement: the implemented per-ref push gate now analyzes the
pushed split tip at its own commit state.

Verified on 2026-09-27 with a local bare remote and a hook that logs both the
stdin refs and `HEAD`:

```
stdin (ref actually pushed): refs/heads/other 384b7636aea2…
HEAD (what the gate scans):  7db139eda9f2… (main)
```

Because CI does not run SonarQube (see the Scope Routing row for `.github/**`),
the push-time gate is the only SonarQube path on the push side; the same
script also runs on `git commit`, so the covered creation path has an earlier
analysis, subject to the commit-tree/working-tree mismatch in the [coverage inventory](quality-gate-enforcement.md#what-the-gate-actually-enforces). If no
earlier gate analyzed the pushed state, pushing a different ref can let it
reach the remote without any SonarQube pass for that state. Using
`--no-verify` likewise skips the push-time gate; it does not erase any
earlier analysis. This is a separate problem from the [commit-creation gaps](quality-gate-enforcement.md#known-finding-uncovered-commit-creation-paths), with a different
trigger and a different remedy, so it is tracked separately rather than folded
into #404: [#405](https://github.com/hailingu/PlotWeave/issues/405).
The commit-side counterpart — a commit analyzed on working-tree state it
does not contain (omitted staged changes, unstaged tracked changes, or
untracked/ignored inputs) — is recorded in
[What The Gate Actually Enforces](quality-gate-enforcement.md#what-the-gate-actually-enforces) as a
boundary of this inventory.
