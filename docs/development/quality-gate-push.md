# 推送门禁与对象身份

维护逐 ref 分派、验证矩阵、残余边界及历史错配证据。本篇由[成本决策记录](quality-gate-cost.md#文档组织约定issue-472)
按 [issue #472](https://github.com/hailingu/PlotWeave/issues/472) 拆出，是该主题详细证据的唯一维护位置。
成本基线、重新评估触发条件与复测方法仍在[决策正文](quality-gate-cost.md#measured-baseline)。
沿用原记录的英文证据，保留测量日期、已实施修复与未验证边界；本次未新增行为或复测结论。

**整理日期**：2026-10-01

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
  The complete gate then runs exactly as before, at the same cost.
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
  peel to a commit fails closed. Every ref line is analyzed or rejected —
  none is silently ignored.
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
definition of the current working tree (uniform-gate rule), so a pushed tree
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

## 安装与凭据状态矩阵（issue #462）

[issue #462](https://github.com/hailingu/PlotWeave/issues/462) 的实现：
`pre-push` 负责安装的期限、失败分派及临时树清理；安装执行器负责子进程组
及安装环境；`sonar-quality-gate.sh` 负责认证令牌的使用阶段。安装仍执行
真实 `npm ci`，不通过跳过 lifecycle 脚本改变依赖构建行为。

| 前置状态与动作（含顺序） | 预期可观察结果 | 跨转换不变量及责任入口 | 对应验证 |
| --- | --- | --- | --- |
| 调用者同时设置两个令牌 → 非检出 ref 安装 → 检查 → 扫描 | 真实 prepare 读不到两个变量；扫描器和 API 仍可认证 | 安装执行器及统一门禁：被分析代码的执行环境不含两个 Sonar 令牌；扫描对象保持被推提交 | pre-push 真实零依赖 npm ci 探针；统一门禁环境探针；既有认证优先级测试 |
| 调用者已导出小写 sonar_token → 保存主令牌或备用令牌 → 检查/覆盖率 → 扫描 | 检查和覆盖率环境不含保存的凭据，扫描器/API 使用所选令牌 | 统一门禁：内部保存变量不得因继承导出属性而泄漏凭据，认证优先级不变 | 统一门禁主令牌/备用令牌导出属性回归 |
| 安装正常结束 → 完整门禁 → 推送 | 远端收到该 SHA，台账绑定该树，临时树移除 | pre-push：安装成功不代替任何门禁步骤，也不修改用户工作树 | 真实 npm ci 成功探针及既有逐 ref 套件 |
| npm 安装非零退出 → 阻止推送 | 保留安装错误，扫描未执行，远端 ref 不存在，临时树移除 | pre-push：未完成安装不得进入门禁或推送 | 安装失败回归 |
| npm 无法启动 → 安装结束 | 立即报告启动失败，不伪装为超时 | 安装执行器：未启动安装不得报告成功 | pre-push-install 启动失败回归 |
| npm 以 0 或非零退出，但同组后台后代忽略 TERM → 完成清理 | 先 TERM、1 秒后 KILL；后代结束后才保留 npm 成功或失败结果 | 安装执行器 close 入口：任何安装完成路径都不得提前解除后代监督 | pre-push-install 正常/失败完成后代回归 |
| 启动前注册 INT/TERM/HUP → spawn 创建进程组且尚未返回时收到信号 | supervisor 保持存活并执行有界清理，返回失败 | 安装执行器启动入口：从创建受监督进程组起，中断处理始终有效 | pre-push-install 启动窗口真实信号回归 |
| npm 成功退出 → 清理后台后代期间收到中断 | 仍完成清理，但最终返回失败 | 安装执行器 interrupt/close 入口：成功不得覆盖已收到的中断 | pre-push-install 完成清理期间中断回归 |
| npm 成功退出 → TERM 或 KILL 发送出现非 ESRCH 错误 | 保留清理错误诊断并返回失败；TERM 失败仍尝试 KILL | 安装执行器：任何清理错误均阻止成功，后续信号成功不得覆盖失败状态 | pre-push-install TERM/KILL 错误注入回归 |
| npm 成功退出且进程组已不存在 → 清理收到 ESRCH | 仍返回成功，不报告清理失败 | 安装执行器：已经结束的组满足清理要求 | 既有真实 npm ci 成功探针 |
| 安装及后代已就绪 → 执行器收到 INT/TERM/HUP（含终端断开）→ 有界清理 | 报告中断；先 TERM、1 秒后 KILL，进程组结束并返回失败 | 安装执行器：各中断入口均保留有界清理，不因 supervisor 退出而遗留受监督安装进程 | pre-push-install 真实 INT/TERM/HUP 信号回归与后代存活探针 |
| 安装超过期限（lifecycle 与其子进程忽略 TERM）→ 强制终止 → 阻止推送 | 超时诊断；进程组结束；扫描未执行；临时树移除 | 安装执行器与 pre-push：失败路径有界终止并清理资源 | 真实 npm ci 超时及子进程存活探针 |
| 超时配置无效 → 请求慢路径安装 | 配置诊断，安装和扫描均未启动 | 安装执行器：无效期限不得退化为无期限执行 | 参数化无效配置回归 |
| 干净 HEAD、混合 refs、标签、删除 ref → 推送 | 原有快慢分派与去重语义保持 | pre-push：逐唯一被推提交执行完整门禁 | 既有快慢路径、多 ref、标签、删除及替换对象套件 |

并发安装不由此修复引入；原有门禁锁仍串行化分析和台账写入。没有自动安装
重试，失败后用户重新执行推送会创建新的临时树。网络 registry 挂起与
lifecycle 挂起共用同一安装期限；测试使用离线零依赖包，不连接外部 registry。
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
状态；ESRCH 表示组已不存在。权限错误可能使后代仍存活，失败诊断不承诺清理完成。
无法启动 npm 时立即失败，不启动后代清理定时器。普通安装失败、超时或
无效配置均阻止后续门禁和推送，钩子的
退出清理移除临时 worktree。此监督依赖 Unix 进程组，Windows 明确失败，
没有新增 Windows 支持；主动脱离进程组的后代不在清理保证之内。
此期限仅约束安装，不是整个门禁的总期限；扫描器仍使用既有的
`SONAR_QUALITY_GATE_TIMEOUT`，检查和覆盖率没有新增超时或步骤缩减。

以下是安装执行器的稳定诊断代码契约，中文解释可调整：

| 代码 | 条件 |
| --- | --- |
| `PRE_PUSH_INSTALL_TIMEOUT` | 安装超过配置期限 |
| `PRE_PUSH_INSTALL_TIMEOUT_INVALID` | 安装期限非合法整数或超出范围 |
| `PRE_PUSH_INSTALL_FAILED` | npm 非零退出或被信号终止 |
| `PRE_PUSH_INSTALL_START_FAILED` | npm 无法启动 |
| `PRE_PUSH_INSTALL_INTERRUPTED` | 执行器收到 INT 或 TERM |
| `PRE_PUSH_INSTALL_CLEANUP_FAILED` | 进程组信号发送失败，除已不存在的组；阻止安装报告成功 |
| `PRE_PUSH_INSTALL_PLATFORM_UNSUPPORTED` | 平台不支持当前 Unix 清理实现 |

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

仅以干净环境启动 supervisor 可以移除一个读取目标，但无法隔离仍持有
认证值的祖先进程或当前用户可访问的凭据资源。启动后删除 `process.env`
也不能等价替代干净启动：按照 [Linux proc_pid_environ(5)](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html)，
`/proc/<pid>/environ` 反映 `execve` 时的初始环境，后续环境修改不会更新
该文件；访问仍取决于系统的进程检查权限。

本项目可验证的保证限于：安装、检查和覆盖率子进程不继承两个 Sonar
环境变量，安装受期限约束，认证仍在扫描器与 API 使用阶段有效。
[安装与凭据状态矩阵](#安装与凭据状态矩阵issue-462)和真实 npm 探针验证这些保证，
不能作为同用户恶意代码的凭据隔离证明。本机验证平台为 macOS，评审中的
Linux `/proc` 攻击探针未在本项目环境复现；此处记录评审报告与系统文档
支持的边界，不声称已完成跨平台攻击验证。

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
