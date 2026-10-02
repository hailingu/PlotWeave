# 门禁生命周期与恢复

维护标记、测试隔离、锁恢复及测试注入边界。本篇由[成本决策记录](quality-gate-cost.md#文档组织约定issue-472)
按 [issue #472](https://github.com/hailingu/PlotWeave/issues/472) 拆出，是该主题详细证据的唯一维护位置。
成本基线、重新评估触发条件与复测方法仍在[决策正文](quality-gate-cost.md#measured-baseline)。
沿用原记录的英文证据，保留测量日期、已实施修复与未验证边界；本次未新增行为或复测结论。

**整理日期**：2026-10-01

## Commit Marker Ownership And Reuse

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
Commands with no wireable hook (see the [coverage table](quality-gate-enforcement.md#what-the-gate-actually-enforces)) remain
ungated. The marker is **single-use** (评审 4120128545): a successful
`check` consumes it, so a later operation — including a same-tree
`--no-verify` commit — cannot reuse it. Since issue #429, the marker also
records the calling Git process identity: both hooks pass their parent PID,
and the helper obtains its start time with `LC_ALL=C ps -p <pid> -o lstart=`.
Reuse requires an exact match of identity, index tree, and bounded age. A
no-staged-change abort before `prepare-commit-msg`, or a signal interruption,
can leave a file on disk; that residue cannot authorize a later Git process.
An editor abort occurs after `prepare-commit-msg` has already consumed the
marker. A missing/invalid process identity or failed lookup disables reuse;
legacy two-field markers are also rejected. The marker remains a dedup hint,
not a trust boundary: any mismatch, expiry, or corruption runs the full gate.
This process lookup is verified on macOS, the repository's supported/tested
platform; an unavailable lookup elsewhere safely adds a gate run. Start time
has `ps lstart`'s second precision: same-PID reuse within the same second is
an unverified extreme boundary, outside normal commit lifecycle assumptions.

### Commit Marker State And Invariant Matrix (Issue #429)

The marker helper owns same-operation reuse. Its `write` entry points are
`pre-commit` and `pre-merge-commit`; `prepare-commit-msg` is its only `check`
consumer. The fix binds reuse to the calling Git process (PID and start time)
as well as the index tree and age. A marker left on disk after an abort must
never authorize reuse by another process, even when its tree and age match.

| Precondition / state | Action / ordering | Observable outcome | Invariant | Verification |
| --- | --- | --- | --- | --- |
| Ordinary commit or automatic non-fast-forward merge | Pre-hook passes → writes → same Git process prepares message | One complete gate; marker consumed | Only the operation that passed can deduplicate | Existing real-Git commit and merge scenarios |
| No staged changes | Pre-hook passes → Git aborts before message preparation → same-tree `--no-verify` commit | First command creates no commit; second executes a new complete gate | An aborted operation cannot gate a later operation | New real-Git issue #429 regression |
| Editor rejects message | Gate passes → message hook consumes marker → editor aborts → next same-tree commit | Abort creates no commit; next command executes its own gate | Commit success is not required to invalidate reuse outside its operation | Real-Git editor-abort regression |
| Interrupted operation or stale marker, including PID reuse | Next operation checks a different PID or start time | Check misses; complete gate required | Tree and TTL alone never establish same-operation ownership | Helper identity-mismatch cases; abrupt signal timing remains unverified, using the same identity rejection path |
| Identity missing, invalid, or process lookup unavailable | Write or check tries to resolve owner | No reusable marker written; check misses | Uncertain identity cannot suppress a gate | Helper invalid/missing PID and failed `ps` scenarios |
| Tree changed, expired/future/corrupt marker, or legacy two-field marker | Check validates all keys before consuming | Check misses | Every reuse needs matching tree, bounded age, and process identity | Helper boundary scenarios |
| Gate fails, fallback-only commit, or replay | Failed pre-hook stops; fallback passes without writing | No unauthorized commit; each fallback/replay gates independently | Fallback never produces reusable state | Existing failure, `--no-verify`, revert, cherry-pick, and rebase scenarios |

Concurrent writers can replace the hint and cause an additional complete gate;
they cannot establish matching process ownership for another Git operation.
This change adds no persistence or application-data transition. The tests run
real Git, hooks, and gate scripts, with only external coverage/scanner/network
commands replaced. Full real coverage and SonarQube remain required at commit
and push. Verification results are recorded in the resolving pull request.

### 门禁测试标记隔离（Issue #428）

本节记录 [issue #428](https://github.com/hailingu/PlotWeave/issues/428)
的测试隔离修复。`scripts/sonar-quality-gate.test.ts` 的 `runGate` 拥有每次
调用的沙箱及清理责任；`gateEnvironment` 必须将 `PLOTWEAVE_GATE_MARKER_PATH`
指向该沙箱，覆盖继承的宿主路径。真实 hook 和标记助手继续执行，外部覆盖率、
扫描器与网络命令沿用已有替身。

| 前置状态 | 动作 / 顺序 | 可观察结果 | 不变量及所有者 | 验证 |
| --- | --- | --- | --- | --- |
| 宿主已有标记，门禁通过 | `runGate` 执行 `pre-commit` 或 `pre-merge-commit` → 写标记 | 本次沙箱内存在带树、时间和进程身份的标记；宿主标记原样保留 | `gateEnvironment` 隔离两条写入口；测试不得修改宿主门禁状态 | 两个成功路径回归用例，执行真实 hook 与标记助手 |
| 宿主已有标记，新增问题非零 | hook 执行门禁 → 失败退出 | 非零退出；沙箱内无标记；宿主标记原样保留 | 门禁失败不能留下可复用标记；环境隔离不改变失败透传 | 两个失败路径回归用例 |
| 未导出宿主标记覆盖项 | 执行 `npm test -- scripts` | 工作仓库标记的存在性及内容保持不变 | `runGate` 每次分配独立路径，避免回退到工作仓库 `.git` | 路由命令前后核对工作仓库标记状态 |
| 真实提交、自动合并或回退提交 | 真实 Git 执行原有 hook 顺序 | 同一次操作去重；后续操作及 `--no-verify` 路径仍运行完整门禁 | 标记助手保有 #429 的进程身份约束 | 既有 `gate-tree-marker.test.ts` 真实 Git 场景 |

本修复不改生产 hook、标记格式或门禁契约；#429 已拒绝其他 Git 进程复用
测试遗留标记，但不替代测试自身的状态隔离。每次运行使用 `mkdtemp` 分配的
独立沙箱，正常成功或失败后均由 `afterEach` 清理。强制终止测试进程后的临时
目录清理未验证：目录仍在系统临时区，不能成为工作仓库默认标记。本变更不涉及
应用数据、持久化协议或异步完成顺序；验证结果随修复 PR 记录。

### 门禁锁的人工恢复（Issue #430）

本节记录 [issue #430](https://github.com/hailingu/PlotWeave/issues/430)
的恢复指引修复。`sonar-quality-gate.sh` 和 `gate-history.sh materialize`
共用目录互斥锁；正常退出会释放锁，SIGKILL 或断电可能留下目录。
门禁仍以原子 `mkdir` 获取锁，获取失败即停止，不检测锁年龄或进程所有者，
也不自动删除或接管锁。

锁获取失败的诊断包含实际锁路径，以及三个稳定诊断代码：
`[SONAR_GATE_LOCK_UNAVAILABLE]` 标识获取失败；
`[SONAR_GATE_LOCK_WAIT_FOR_RUNNING_GATE]`（issue #465）说明运行中的门禁
可能正当持锁——推送门禁（慢路径含被推树依赖安装与完整检查）可持有该锁
数分钟，期间提交、合并与推送会被拒绝，等待其结束后重新执行原操作即可，
不要清理仍被持有的锁；
`[SONAR_GATE_LOCK_RECOVERY_COMMAND]` 后跟可在 POSIX shell 中执行的
`rmdir -- '<锁路径>'` 命令，路径中的单引号会被转义。
先等待正在运行的门禁和记录物化结束，确认没有相关进程且目录确为残留锁后，
才可执行该命令，再重新执行原 Git 操作的完整门禁。`rmdir` 只移除空目录；
非空目录、权限问题或缺失父目录仍需人工检查，不能按残留锁直接清理。

不变量由 `sonar-quality-gate.sh` 的锁获取与退出清理持有；入口是四个 Git
hook，记录物化是共享该锁的另一个入口，其有界等待和 pending 保留语义沿用。
获取失败仍是 #430 的单次 fail-closed 语义：不排队等待、不检测锁龄或进程
所有者——issue #465 只补文案（可区分「运行中需等待」与「残留需恢复」），
不改变锁强度。

| 前置状态 | 动作 / 顺序 | 可观察结果 | 不变量 | 验证 |
| --- | --- | --- | --- | --- |
| 空闲锁 | 门禁获取锁 → 成功或扫描失败退出 | 完整成功或原失败透传；锁释放 | 只有持锁者可执行检查，正常退出释放本次锁 | 成功与扫描失败的锁清理回归 |
| 另一个门禁持锁 | 后一个门禁尝试获取同一路径 | 非零退出、无检查或扫描、原锁保留；包含恢复指引 | 获取失败不得删除他人的锁或并发进入门禁 | 持锁期间第二次运行的行为回归 |
| 推送门禁持锁数分钟（issue #465 慢路径窗口） | 期间提交/合并触发门禁获取 | 毫秒级失败；输出等待指引代码说明窗口时长与重试方式，恢复命令仍只针对确认的残留锁 | 等待指引不得暗示排队或自动重试，不得弱化恢复命令的人工确认前提 | 锁被占用时的等待指引回归 |
| 测试门禁持锁后被 SIGKILL | 终止测试专属进程组 → 再运行门禁 | 残留锁保留；非零退出并给出路径和清理命令 | 无法确认锁的所有者时仍拒绝执行 | 隔离沙箱中的真实门禁强杀回归 |
| 已确认持锁者结束 | 执行诊断中的命令 → 重试门禁 | 仅删除目标空目录；重试执行完整检查并通过 | 恢复指引不能跳过任何门禁步骤 | 强杀后的清理与成功重试 |
| 锁路径含空格、单引号或 shell 替换符 | 获取失败 → 执行输出的命令 | 正确移除目标，替换符不执行，旁侧文件保留 | 恢复命令必须把路径作为一个字面参数 | 特殊路径命令执行回归 |

验证边界：断电未实测，依赖与 SIGKILL 相同的退出清理不执行路径；人工确认
无持锁进程不是自动检测功能，若清理期间又启动其他门禁，仍需使用者协调。
记录物化的强杀未新增独立用例，它共享同一个目录锁和正常退出清理方式；
已有等待、超时及 pending 保留回归继续验证该入口。本变更不涉及应用数据。

## Test Injection Boundary

The [gate-strength record](quality-gate-cost.md#impact-on-gate-strength)'s "no environment variable reduces the check set" claim has one
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
elsewhere does remove the in-repository self-report for that run.
`PLOTWEAVE_GATE_REPOSITORY_ROOT` (`scripts/sonar-quality-gate.sh`,
`scripts/check-static.sh`, `scripts/rust-coverage.sh`, issue #405) belongs
to the same injection class but is stronger than the path overrides above:
it redirects **which tree the gate analyzes**, and the `pre-push` slow path
uses it to point the current gate scripts at the pushed commit's temporary
worktree. A shell that exports it can therefore analyze an arbitrary
directory instead of the state a Git operation is about to record or push —
the same class of explicit evasion as `--no-verify`, prohibited by
`AGENTS.md`.
