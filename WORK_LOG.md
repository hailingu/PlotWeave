# Issue #933：独立清除场次

## 基线与恢复点

- 授权：修复 #933；从最新 dev 隔离开发，正常门禁和 draft PR → CI / 实际 review → 合并 dev → 关闭 issue → 仅清理本任务资源并安全同步 dev。
- 2026-10-28：issue 当前正文已读，无评论；无开放 PR 或命中 933 的已有 PR。主工作区干净，最新 dev / origin/dev 均为 `d4df25e0214a466a181dbaf55d368055a0250273`。
- 隔离 worktree：`/tmp/plotweave-933`，分支 `fix/933-clear-scene-number`；未操作 main、release、tags 或其他 issue。
- 已读 AGENTS、工程 / TS / Swift / Rust / 开发与门禁规范；仓库无 `.agents`，用户级 `.agents/skills/SKILL.md` 是仅供动画 review 的禁自动调用技能，本任务无动画改动，不适用。
- hooks 保持 `.githooks`；Node 24.18.0；本机仅 Xcode 27.1，规范 / CI 为 27.0 / SDK 27.0，本机验证将如实记录实际版本。
- #925 共享 pending 与锁仍在，#829 `ledger_git` 清除 GIT_DIR 的归属修复仍在。初始 shared / task index、pending（若存在）及 ledger 快照保存在任务外部证据目录 `evidence-933`，不回填历史。
- 截图 Library ID `libfile_5faeb482627481918205684c8b793818`：已读当前 Library 技能和 consumer-local 物化说明，但本环境只有创建/替换/上传工具，无 read/search/prepare_materialize，无法取得像素。以 issue 已核实的截图描述作为布局参考，不冒称查看图片，不把私人下载 URL 写入 PR。

## 方案与影响调查

沿用现有可选字段契约：`sceneNo` 缺失表示未设置；运行态清除补丁为 `undefined`，JSON 持久化省略该字段。有值仍必须是正安全整数；null、0、NaN、字符串等非法非空值沿用归一化重编号。旧项目合法编号不变，schemaVersion 维持 1。原生使用既有 `editor.clearNodeField`，React 仍是文档与撤销的唯一所有者。

实际消费者：场景表单、原生数字控件 / clear allowlist、模型归一化、卡片 / 检查器、大纲 / 节拍兑现、导出正文与分镜附录、AI 摘要 / 标签、新节点编号。Swift / Rust 存储按 JSON 透传，无 sceneNo 独立必填校验；需用真实 Swift 存储 + WKWebView 保存重开测试确认。AI 可写值域仍为正整数，不增加未请求的 AI 清除协议。

## Key State And Invariant Matrix（生产修改前）

| 状态 / 前置条件 | 动作 / 顺序 | 预期结果 | 不变量 / 所有者 | 验证计划 |
| --- | --- | --- | --- | --- |
| 场次7、集号2，含其他内容与连线 | 分别点击各自清除 | 仅目标字段为空 | 节点、内容、连线、其他节点不变；useNodePatch | React 生产控制器、原生实际控件 |
| 两个字段有值 | 连续清除 → 撤销两次 → 重做两次 | 精确恢复两个字段 | 不同字段历史不误合并；history | 生产控制器 / WKWebView |
| 场次已清除 | 失焦、切换节点、保存、重开 | 缺失 sceneNo，不自动回填 | serialize / normalize / Swift 存储 | JSON roundtrip、真实磁盘与重开 |
| 缺失场次 / 只有一个字段有值 | 重复清除、重新输入8 | 明确空态，可恢复合法编号 | 不写 null/0/NaN，其他字段不变 | 表单、native intent、控件 |
| 旧项目合法编号，非法非空编号 | 加载 / 再保存 | 旧合法值保留，非法仍修复 | normalizeSeqFields | 模型回归 |
| 空场次场景仍有分镜 / 剧情流 | 卡片、大纲、AI、MD/JSON 导出、新建场景 | 可读空态，内容保留，新编号有限合法 | 各消费者，不改排序 / 引用 | 消费者回归、现有全量测试 |
| 过期项目 / 非 scene / 必填字段 | clear 请求 | 拒绝且无变更 | nativeNodeActions | 生产控制器回归 |

并发存储协议不改变；重复清除幂等，不引入异步副作用或重编号其他节点。真实 UI、注入 intent 和未验收范围分别记录。

## 执行与验收

待补：Red/Green、路由检查、完整门禁、PR/head/CI/review、cleanup/devsync。


### 复现与初轮结果

- Red：`vitest run src/model/sceneNumber.test.ts src/editor/nativeCanvas/nativeEditorShell.test.tsx -t 'omitted sceneNo|sceneNo clears independently'`：两例按预期失败（缺失值补成1；原生 clear 被拒绝）。实现后两文件 48/48 通过。
- 模型 / 消费者 / 实际 React 表单 / 既有 NodeSettingsPanel：38/38 通过；`npm run typecheck:strict`、`npm run build`、format、lint（零告警）、size 通过。
- 初次 React 表单测试的 label 查询会同时命中数字框与 label 内清除按钮，改按语义 role=spinbutton 定位，未削减断言。
- 原生首轮中真实按钮、独立清除、历史和重新输入均执行；磁盘断言读到旧种子编号，因为仅等待首页路由而未等待保存回执，补充有界磁盘读取等待。额外检查器窗口曾影响后继 WKWebView 可见性，改直接操作真实 shell 的检查器，移除额外窗口。全量仍须重新通过。
- 首次非提权全量 frontend 测试中的 hook 进程身份 / ps 检查受沙箱限制；不改测试或门禁，后续在具备必要进程权限的运行环境复验。


### 合约补查与验证进展

- 修正 fixture 的控件定位后，原生第三轮的 `sceneNumberClearControlsPersistAndUndoIndependently` 实际交互通过：使用真实 shell 检查器按钮、公开 AppKit 文本委托、生产 WKWebView 与真实 Swift 磁盘；覆盖7/2两方向清除、连续清除/两次撤销重做、换选、重录8、再清除、失焦、保存重开与整图不变量。全量结果见后续 gate 日志。
- 全量前端正常权限回归：3742 项全部通过。随后补查 serializer 对象边界，发现 clear 补丁会留下自有 `sceneNo: undefined` 键（JSON stringify 虽会省略）；增加契约断言观察 Red，再在模型序列化层直接省略该键，所有宿主消费同一文档对象。未把该测试改进误报为原生第三轮失败；真实 Swift 保存重开已通过。
- 空态 / 清除 / 拒绝请求定向回归累计80项通过（后加 serializer 用例另计）；非 scene、必填字段、陈旧项目、已删除目标均拒绝；重复清除不增加历史步骤。
- 复杂度检查：新增 / 修改 describe 与 executable callbacks 均低于80代码行；原生实际生命周期测试超过60行的讨论阈值，保留为一个有序生命周期，历史/文档读取/控件操作已抽为语义 helper，拆成独立测试会失去同会话保存重开不变量。行跨度及嵌套手审完成；Sonar 的实际认知复杂度结果在后续门禁记录中另列。
- 文档已同步 graph-model、normalization、commands、UI设计与原生能力表；不新增 AI 清除协议，不改变编号域、排序或 Rust/Swift 存储格式。
- 门禁服务只读检查：本机 Sonar `UP`，沿用现有凭据且未打印值。后续普通 commit / push 仍执行全部版本化 hooks。


### 断连恢复（2026-10-28）

- 执行器短暂 unavailable；最终 native 回归启动调用返回 transport disconnected。恢复后先查本地 HEAD/status、进程、目标日志与远端 refs：HEAD 仍为基线，全部27个改动路径保留，最终日志不存在、无相应回归进程，远端无本任务分支，确认该启动未执行。之后才重新启动最后一轮原生回归。
- 全量原生第三轮已确认：452 tests / 95 suites 全部通过；9600/10651 App Swift lines（90.13%，79/79 sources，report-only）。实际版本：Xcode 27.1 / SDK27.0 / macOS27.0.1；托管 CI 仍验证规范的 Xcode27.0。
- 最后静态复核发现新增类型探针使用空对象类型被 ESLint 拒绝；改用 `Omit<SceneSpec, 'sceneNo'>` 的领域形状探针，无 suppression，重验通过后再提交。
- 原始 Library 截图仍未取得像素；新增本地验收图来自合成项目的真实 shell（7/2 与清除场次后集号2），非原始截图。实际 AX 按钮/文本委托测试、浏览器 DOM/intent 注入回归和未验范围分别披露；完整 VoiceOver、物理键盘 Tab 导航、系统 IME 与压力测试未执行。

### 提交前最终路由结果

- 最终原生：`sh scripts/test-native.sh` → 452/452 tests、95 suites，通过；App Swift 9601/10651 lines = 90.14%，79/79 sources，report-only。此轮包含最终序列化与验收图逻辑。
- `npm run lint -- --max-warnings=0 && npm run typecheck:strict && npm run check:size && git diff --check` 全通过；size 检查903项。前端构建通过，最后一次序列化修改后的模型/标签/生产控制器回归250/250通过；完整前端覆盖率将在正常提交 hook 中重新生成。
- 合成项目验收 PNG 已保留到任务证据目录并查看像素：场次7/集号2 → 场次空/集号2，卡片和大纲显示未编号。NSView bitmap 对系统按钮图标的呈现不足以单独完成视觉验收；按钮的名称、启用、动作由真实 AX 控件测试验证。原图、物理键盘 Tab、VoiceOver 与真实 IME 仍不冒称通过。
- 暂存27个任务路径；主 dev 工作区仍干净。已安全停止本任务先前中断测试留下的两个孤儿 check-static 进程树；没有清理用户或其他任务进程。

### 第二次断连恢复与聚焦保护

- 06:42 UTC恢复后确认 HEAD 仍为 `d4df25e0`，未生成提交、未推送；commit-gate.log 结束于前端覆盖率启动。正常 hook 已折并并暂存1行真实既有 pending，原字节保留，不伪造历史记录。已额外保存断连后的 shared/task pending/index/ledger 快照。
- 无 Git/门禁进程持锁，锁目录确为空残留；按规范仅 rmdir 清理。仅停止本任务中断测试的孤儿 check-static 沙箱进程树，未动其他进程。
- 新增 `delayedNumberProjectionPreservesFocusedDraft`：真实数字框聚焦输入37后收到旧值7投影，应保留37。先观察原 unconditional-refresh 实现按预期 Red（草稿被覆盖，5秒有界等待失败）。
- 收窄修复：恢复原 `if !focused` 投影刷新保护；清除按钮明确设置 `focused=false` 后清空本地草稿并发清除。额外断言清除后域撤销时真实输入框恢复7，避免将新能力建立在破坏快速输入的基础上。

- 聚焦回归首次 Green 仍失败，进一步核实是夹具未先建立 SwiftUI 焦点。夹具现通过公开 AX 聚焦、实际 field editor 和原生编辑命令的可观察错误回执确认焦点前置条件。为排除“测试只是测到未聚焦”的误判，短暂恢复 unconditional-refresh，再运行完整原生公共入口；`native-draft-focused-red.log` 证明焦点/编辑前置条件通过，而迟到投影仍把37覆盖成7，预期 Red 成立。随后恢复 `if !focused` 修复。
- 完整 build 发现新测试的 `Object.hasOwn` 超出当前 TS 库定义，改为项目现有 `Object.prototype.hasOwnProperty.call`，不升级编译目标。重新 `npm run build` 与8项模型编号回归通过。

### 聚焦修复最终 Green 与第二次提交尝试

- `native-draft-focused-green.log`：完整原生453 tests / 95 suites 通过，9615/10666 App Swift lines = 90.15%，79/79 sources，report-only。聚焦草稿37挡住迟到值7、清除撤销真实输入框恢复7均通过；其他原生测试断言保留。
- 收尾读取期间再次短暂断连；恢复后先确认最终日志 TEST SUCCEEDED、无测试/Git/门禁进程和共享锁，HEAD仍为基线，远端无本任务分支。未重复启动已通过的回归。
- 29个任务路径（含正常 hook 折并的1行既有台账）已暂存。现在重新执行普通 commit 的完整 gate，后续 PR/head/CI/review 与最终清理记录继续保存在任务外部 WORK_LOG，避免运行中修改被推送的树。


### Sonar 首次实测与修正

- 第二次提交 gate 的前端282文件/3743测试通过，行覆盖率97.20%；Rust 两工作区覆盖率与测试通过。Sonar 报告新代码覆盖90.6%、重复率0.41941%，但新增1项 `typescript:S3776`：`nativeNodeExtra` 认知复杂度16，阈值15。Quality Gate失败，未生成提交。
- 将“允许的可选字段清除”作为同文件私有函数 `clearNativeNodeField`，命令分发器保留原职责；节点解析、白名单、幂等与历史入口不变。不加 suppressions，不改规则或阈值，修复后重跑定向测试与正常 gate。
