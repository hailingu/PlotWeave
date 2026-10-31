# ub-mode 本地发布门禁

[#941](https://github.com/hailingu/PlotWeave/issues/941) 在现有本地门禁前增加
`/ub-mode` 技能检查。它是工程流程，不能把读取 SKILL.md、一个空脚本或
`passed: true` 当作已执行技能。

技能按 `PLOTWEAVE_UB_SKILL` 显式路径、仓库 `.agents/skills/ub-mode/SKILL.md`、
个人 `~/.agents/skills/ub-mode/SKILL.md`、个人 `~/.codex/skills/ub-mode/SKILL.md`
查找。执行者须完整阅读实际来源并落实 TDD、根因、领域形状、边界、重构和行动
日志。缺失技能直接阻断；本仓库不复制一个伪技能或安装凭据。

## 使用

1. 在任务分支完成修复，记录最小失败测试、通过测试、重构和实际人工审查。
2. 把 JSON 审查记录纳入最终提交；字段为 `reviewer`、`tdd`、`rootCause`、
   `model`、`boundaries`、`complexity`、`duplication`、`tests`、`log`、
   `testCommand`、`unsupported`，每项须有具体非空说明。`testCommand` 是实际
   变异回归命令，不是发布命令。文档变更应说明 TDD 不适用。
3. 正常提交，现有静态、覆盖率、Sonar、pending/ledger 归因要求均保留。
4. 干净的最终 HEAD 执行：

   ```sh
   npm run ub:check -- dev docs/testing/issue-N-ub-review.json
   git push -u origin <task-branch>
   npm run pr:create -- 'fix(scope): summary' /tmp/pr-body.md
   ```

检查运行 `npm run test:coverage -- --maxWorkers=<预算>`，再为 base..HEAD 中新增或
修改的受支持生产源码运行 `crapper --use-existing-coverage --threshold 9.99`、
`dryer --threshold 0.8`、`mutator --mutate-all --no-coverage --test-command <记录命令>`。
覆盖率和变异并行数遵循既有 `PLOTWEAVE_GATE_CPU_BUDGET`，未设置或空值时为4；
非法预算阻断。变异检查重跑所有候选，不能复用旧 killed 缓存或跳过未覆盖候选。
重复候选即使 dryer 返回 0 也阻断；变异工具失败同样阻断。工具只接受明确变更
路径，避免纯文档时空参数意外扫描全仓库。测试、明确登记的测试设施和删除的源码不参加
生产复杂度/重复/变异扫描；它们通过实际回归、人工审查及原门禁约束。

伴随工具缺失时，只有技能允许的人工降级可用：在审查 JSON 的 `fallbacks`
按 `complexity`、`duplication`、`mutation` 记录具体检查和结果。命令已安装但
执行失败绝不降级。无受支持源码时，`unsupported` 记录人工审查范围；Swift、
shell 等工具不支持的语言仍须逐项人工检查，并通过原生/脚本原门禁。人工模式
日志明确标注 `MANUAL`，不会声称 CRAP 或 mutation score。覆盖率命令不能降级。

## 对象与发布边界

成功记录和原始日志保留于 common Git 目录 `plotweave-ub-mode/<commit>/`。
记录包含最终原始 commit/tree、base、技能字节摘要、人工审查及四项检查产物
摘要。24 小时到期、未来时间、提交改变、技能改变、产物丢失或改写均失败。
base 必须是完整原始提交标识，且为本地 dev 与 HEAD 分叉点本身或其祖先；
执行与发布两端均检查，不能选择任务自身提交来缩小检查范围。
开始重检会撤销此提交旧记录；检查失败不保留通过记录。执行前后检查 HEAD 与
工作树干净状态，避免把修改中的树当最终对象。检查产物忽略，不写 tracked
ledger，也不改 pending、索引或 #829 的字节归因。

`pre-push` 对每个唯一的非删除对象校验，位于 docs-only 跳过之前；随后仍执行
原有逐 ref 分流、隔离 worktree、静态、覆盖率、native 及 Sonar。PR 入口复用同一
校验，再读取真实 `origin` 分支 head；不一致阻断，成功仅创建针对 `dev` 的 draft。

Git hooks 和本地 PR 入口约束正常发布流程。直接调用外部 gh/API、禁用 hook 或
篡改本机记录不能由本机脚本在服务端强制阻止；本记录不是签名证明，人工判断
也不能自动证明。既有分支保护、实际 review 和四项 CI 保留。不得利用此边界绕过
用户要求；本次门禁自身首个 PR 也执行完整技能检查。

状态矩阵、TDD 与验证见 [#941 验证记录](../testing/issue-941-ub-mode.md)。

中断生成的 `target/mutation-workers/**` 与 `target/mutator-backup/**` 不属于维护测试输入，Vitest 测试发现显式排除；生产覆盖率范围和下限不变。Git 读取清除调用方定位环境，以显式仓库的实际索引、原始对象和 common Git 目录为准，避免嵌套钩子或其他仓库环境改变发布身份。

Prettier 与 ESLint 同样排除上述两个生成目录，维护源码继续执行原约束。变异检查必须与格式化、暂存、提交和其他全仓检查串行；中断后先确认执行器已退出，再检查恢复副本和工作树，不能并行写入源码或把失败基线的变异分数当通过证据。
