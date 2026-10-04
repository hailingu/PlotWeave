# 重复度处置政策与实测

本页落实 [issue #504](https://github.com/hailingu/PlotWeave/issues/504)，维护重复度处置约定和可查询基线。重复度与[覆盖率地板](typescript-standard.md#coverage-floor-and-baseline)、[完整质量门](quality-gate-enforcement.md)并行，不替代任何既有门禁。

## 统计口径与处置

- 质量门沿用 `new_duplicated_lines_density > 3%` 时失败的服务端条件；恰为 3% 的比较语义不改，但工作目标是低于 3%。达到 **2.8%** 时，先定位本次新增的实际 CPD 文件和重复块，优先复用已有能力或抽取语义相同的实现，再继续复制型新增；不得靠提高阈值继续提交。整体重复度用于定位存量，没有新增整体硬门禁。
- 涉及重复实现的新增或抽取，在 PR 中记录修复前后两个查询的输出、分析版本和新代码周期；关注百分比，同时比较重复行和重复块，避免把分母增长误当作消除重复。若值缺失或周期模式/长度变化，明确说明不可直接比较，不能填写为 0；滚动窗口起点的自然前移另行记录。
- 本次样式令牌测试已按既有 `sonar.test.inclusions` / `sonar.exclusions` 组合分类为测试，文件指标为 `qualifier=UTS`、重复行 0。issue 中的 10 行归一化窗口只是定位线索，不是 Sonar CPD；不能以它证明质量门指标改善。测试脚手架抽取仍可用于维护性改进，但不作为本次 CPD 修复。
- **本次不新增 CPD 排除**。今后仅在明确不适合抽取的逐项文件上、经仓库所有者明确批准并记录原因/影响面后，才允许在版本化配置中登记精确排除；不得使用宽泛 `sonar.cpd.exclusions`、关闭规则、`NOSONAR` 或增加覆盖率排除来隐藏发现。测试设施分类沿用现有双向守卫，不能把产品实现误归类为测试。
- 保留完整门禁：Quality Gate `OK`、新代码未解决问题 0、前端和 Rust 整体行覆盖率均至少 80%；失败则修复并重跑，提交与推送仍受钩子约束。

## 修复前后实测

2026-10-03 修复前查询（本地 `dev` 为 `b59ece3`，新代码周期 30 天）：

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 新代码重复度 | 2.79048% | 2.73805% |
| 整体重复度 | 4.4% | 4.3% |
| 重复行 | 2991 | 2937 |
| 重复块 | 250 | 248 |
| Quality Gate | OK | OK |
| 新代码未解决问题 | 0 | 0 |

`ImageNode.tsx` 与 `ShotNode.tsx` 各有 27 重复行 / 1 重复块，分别为 21.1% / 17.9%。 修复后两文件及共享 hook 均为 0 重复行 / 0 重复块；整体实减 54 行和 2 块，而非只增加统计分母。修复后测量任务为 `ff542ff5-8006-4e26-8ffe-36303d77ac30`（源码抽取完成、提交前的工作树）。新代码周期仍为 30 天滚动窗口，起点从 `2026-09-03T01:43:58+0000` 前移至 `2026-09-03T03:22:26+0000`；不把新代码百分比的全部变化单独归因于抽取，整体与逐文件指标提供直接消除重复的证据。抽取范围为两者相同的项目媒体加载生命周期，不调整渲染、样式令牌、资产查找或媒体门面契约。

### 可复现查询

在仓库根目录执行；主机地址和令牌由现有环境提供，认证经 stdin 传入，不写入仓库或命令参数。以下两条分别查询质量门（含新代码重复度）和整体指标：

```sh
printf 'header = "Authorization: Bearer %s"\n' "${SONAR_TOKEN:-$PLOTWEAVE_SONAR_TOKEN}" |
  curl --config - --silent --show-error --fail-with-body \
    "$SONAR_HOST_URL/api/qualitygates/project_status?projectKey=PlotWeave"
printf 'header = "Authorization: Bearer %s"\n' "${SONAR_TOKEN:-$PLOTWEAVE_SONAR_TOKEN}" |
  curl --config - --silent --show-error --fail-with-body \
    "$SONAR_HOST_URL/api/measures/component?component=PlotWeave&metricKeys=duplicated_lines_density,duplicated_lines,duplicated_blocks"
```

修复前输出投影（字段和值原样保留）：

```json
{"status":"OK","metricKey":"new_duplicated_lines_density","comparator":"GT","errorThreshold":"3","actualValue":"2.79048"}
{"metric":"duplicated_lines_density","value":"4.4"}
{"metric":"duplicated_lines","value":"2991"}
{"metric":"duplicated_blocks","value":"250"}
```

修复后同两条查询的输出投影：

```json
{"status":"OK","metricKey":"new_duplicated_lines_density","comparator":"GT","errorThreshold":"3","actualValue":"2.73805"}
{"metric":"duplicated_lines_density","value":"4.3"}
{"metric":"duplicated_lines","value":"2937"}
{"metric":"duplicated_blocks","value":"248"}
```

## 关键状态与不变量矩阵

以下用例在实现前选定。生命周期由 `useAssetMedia` 拥有；入口为图片产物 `OutputImage` 和分镜引用 `RefThumb`，两调用方保留 `key={asset.id}` 的首帧清理语义。测试中的破坏模型是复制媒体加载实现、遗漏清理、把迟到结果写回当前资产，或丢失失败占位。

| 前置状态 | 动作或事件顺序 | 可观察结果 | 必须保持的不变量 | 测试或验证缺口 |
| --- | --- | --- | --- | --- |
| 两节点均需要项目媒体 | 经共享能力请求 URL | 只有一个媒体请求实现所有者 | 两入口遵循同一过期结果/失败语义；TypeScript 编译器解析实际调用签名 | `assetMediaOwnership.test.ts` 结构契约先失败后通过 |
| 首次挂载，URL 在途 → 成功 | 等待门面返回 | 在途无图片；成功显示正确 src/alt/class | 渲染属性与各节点原接线一致 | 两节点既有渲染测试 + hook 取值测试；class/alt 属性差异复核 |
| A 已成功；换绑 B 在途或失败 | 以 B 的 id 重挂载；B 请求完成 | 立即清除 A，失败显示原占位 | 旧图不冒充当前资产，错误局部隔离 | 两节点既有 #131 生命周期用例 |
| A 在途；切到 B；A 成功或拒绝迟到 | B 成功后 A 完成 | 仍保持 B 的 URL 和成功态 | 清理后的请求不更新当前实例 | hook 乱序成功/失败测试 + 分镜既有乱序用例 |
| 项目变化、资产 id 相同 | 旧项目读取未完成时切换项目 | 清旧图并加载新项目；旧结果无效 | 资源身份由 projectId + assetId 决定 | hook 项目切换用例 |
| URL 成功但图像解码失败 | img 的 onError | 原来的错误文案/⚠，图片消失 | 解析失败和解码失败同样可见；不会影响其他引用 | 两节点既有解码失败用例 |
| 同 id 资产对象重建、卸载、失败后重挂载 | 无关编辑 / 卸载 / 重新挂载 | 不无故重取；旧请求无效；恢复后显示图片 | 依赖只为项目/id；每个挂载独立拥有请求 | hook 用例 + 分镜既有同 id / 恢复用例 |

没有数据模型、落盘、重试机制或媒体 URL 释放契约变更；不添加自动重试。真实 Tauri WebView 像素不在此次结构抽取验证内；既有媒体 IPC 边界保持，组件测试只替换外部媒体门面并断言实际 DOM。

## Rust 测试重复度续修（issue #504）

PR #505 已完成媒体 hook 抽取；续修以同一统计口径下的 2937 重复行 / 248 重复块为基线。Rust 测试沿用当前 `FIL` 分类，不修改排除项、阈值、测试入口数或模块图案例数守卫。

### 实现前关键状态与不变量矩阵

| 前置状态 | 动作或事件顺序 | 可观察结果 | 不变量所有者与入口 | 测试 / 验证缺口 |
| --- | --- | --- | --- | --- |
| 图库、删除日志、媒体协议测试各自构造磁盘输入 | 经共享能力创建独立临时根、写原始索引或日志 | 各用例得到相同原始 JSON/字节和真实文件身份 | `library_fixture` 只构造输入，不调用生产净化；各命令/恢复/协议测试仍拥有具体断言 | 现有 `library`、`library_journal`、`media_protocol` 测试；声明所有权守卫先失败后通过 |
| 脏索引、旧数组日志、冲突或中断恢复 | 原样写入后执行实际命令、恢复或媒体读取 | 局部隔离、冲突保留、摘要折叠、原件保留行为不变 | 原始输入与实际生产边界相互独立；inode/dev 从真实磁盘读取 | 现有恢复四分支、只读、冲突、折叠及媒体字节断言；非 Unix 身份仍为既有未验证边界 |
| 测试门控语法或后续生产依赖 | 解析每个既有字符串案例，构图并求环 | 排除测试边，保留显式生产边与真环 | `module_graph` 解析器拥有依赖语义；公共断言仅复用拓扑，所有测试入口/输入及预期边和环保留 | 全量模块图语法、cfg、glob、命名空间、fail-closed 与案例数守卫；不改变语法支持范围 |
| 下载重定向缺头、非 UTF-8、非法 URL/协议或非公网目标 | 真实本机服务器响应，经实际客户端逐跳检查 | 相应拒绝错误与诊断，拒绝前的请求跳数不变 | `fetch_image_url_with` 拥有安全边界；测试助手只执行请求并断言结果 | 六个原有独立失败用例，保留原始响应字节和跳数；成功链、状态码、超限中止原用例继续执行 |

此次只重构测试设施，不改变 UI、IPC、持久化契约或重试状态；并发隔离由唯一临时目录和既有并发/真实文件系统测试验证，下载仍经实际服务器而非模拟调用。额外入口没有新增生产状态，非 Unix 和真实 WebView 不在本轮覆盖平台内。

### 续修验证与实测

续修前为 `64fd2c8` / 分析 `140b83ae-95d4-4a5b-b1f5-5556e63af3c4`；续修后为提交前工作树，计算任务 `59e6eb81-77ca-4dc0-bd12-6a8c8d7b095e` / 分析 `302c1b13-cce5-43d8-9608-76c493c33b88`。扫描实际索引 **492 文件**、对 **285 文件**计算 CPD；质量门同时存在新代码覆盖率、重复度和问题条件，均通过。三个批次作为同一测试设施变更验证；下表按不重叠领域比较，不声称各批曾单独扫描。

| 范围 / 指标 | 续修前 | 续修后 |
| --- | --- | --- |
| 项目新代码重复度 | 2.73805% | 1.54186% |
| 项目整体重复度 | 4.3% | 2.4% |
| 项目重复行 / 块 | 2937 / 248 | 1640 / 110 |
| B1 图库、日志、媒体 / 资产测试重复行 / 块 | 957 / 81 | 713 / 60 |
| B2 模块图测试重复行 / 块 | 1573 / 136 | 609 / 29 |
| B3 图片生成测试重复行 / 块 | 190 / 18 | 101 / 8 |

实际消除 **1297 重复行和 138 重复块**。B1 不包含 `library/group_commands.rs` 的 36 行 / 2 块产品重复；三个新增共享/守卫文件各为 0 重复行 / 0 块。B3 的下载文件由 100 行 / 11 块降至 11 行 / 1 块，其他图片生成测试保持原指标。逐文件查询采用 `PlotWeave:<仓库相对路径>`，无缺失值，按上述领域汇总 `duplicated_lines` / `duplicated_blocks`；生产序列化 32 行 / 2 块也没有变化。

周期模式与参数均保持 `NUMBER_OF_DAYS` / `30`；服务端返回的起点从 `2026-09-03T03:22:26+0000` 变为 `2026-09-03T07:19:37+0000`。新代码分母 `new_lines` 从 **107266** 减至 **106365**，并非靠增加分母降百分比；周期起点变化仍使新代码百分比不能单独归因于抽取。旧整体总行数未单独采样，不推算其精确分母；项目与逐文件重复行/块提供直接收益证据，整体重复度同步改善。

同前述两条可复现查询的续修后输出投影：

```json
{"status":"OK","metricKey":"new_duplicated_lines_density","comparator":"GT","errorThreshold":"3","actualValue":"1.54186"}
{"metric":"duplicated_lines_density","value":"2.4"}
{"metric":"duplicated_lines","value":"1640"}
{"metric":"duplicated_blocks","value":"110"}
```

矩阵验证映射与实现边界：

- B1：`library_fixture_capabilities_have_one_owner` 实现前因 5 个 `cap` 声明所有者失败，抽取后通过；复用原 `library_index::testutil` 的形状能力，保持其 `character` 默认值，图库最小条目仍为 `other`。真实磁盘四分支恢复、冲突/只读、折叠与媒体字节测试全部通过。`library/recovery_tests.rs` 的 RAII 损坏原件夹具保留，因其原始非 UTF-8 字节/备份与析构所有权不同；不把它改为 JSON 写入。
- B2：七个案例文件接入共享拓扑/断言，共复用 44 处场景装配；全部原 `#[test]` 入口及循环语法输入经逐项比对保持，所有模块图正反例、真实仓库断言和既有元守卫通过。类型/值、cfg、glob 的输入和预期边/环保留在原用例；共享助手只收敛完全相同的拓扑和结果断言。
- B3：六个拒绝入口保留各自服务器响应、原始非 UTF-8 头值、错误诊断及请求跳数；合法链、404 状态码与超限即中止原用例一起通过。持久化取消/项目删除用例继续直接持有锁、登记和落盘顺序，不把并发时序折成下载拒绝参数表。
- 残留重复：日志的冲突/隔离/累计计数和 `indexUncertain` 分支仍显式编排不同磁盘状态及恢复顺序（如 `recover_marks_conflict_when_original_occupied`、`recover_folds_bulk_verified_completed_entries`、不确定态恢复用例）；模块图不同别名链、字段列表与宏/平台边界仍保留不同拓扑和预期边集；库归一化键预留、只读身份和投毒媒体等领域断言没有合并成通用快照。它们仍有场景专用抽取空间，但不据此削弱独立结果断言或减少案例。产品候选的 68 行按 issue 的 D 边界保留，避免引入恢复报告顺序或序列化字段契约变更。

验证在固定 Node 24.18.0 / Rust 1.95.0 下执行：

- 在 `src-tauri` 执行 `npm --prefix .. run check:size && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`：通过，655 单元测试、5 集成测试及原生退出目标通过。共享拓扑最后收敛后再执行 clippy，完整门禁中的 Rust 覆盖率运行也执行全部 655 单元测试。
- 根目录 `npm run sonar:gate`：静态检查、前端 **184 文件 / 2790 测试**、新鲜双端 LCOV、扫描与服务端等待全部通过；LCOV 整体行覆盖率 **98.15% / 87.35%**，Quality Gate `OK`、新代码未解决问题 **0**，服务端新代码覆盖率 **91.9%**。并发使用 `VITEST_MAX_WORKERS=2`，未跳过测试或门禁步骤。
- 文档无配置自动语义检查，按所有权、三个领域指标、周期/分母、矩阵验证和交叉链接结构化复核；格式检查仍由完整门禁执行。新增/实质修改执行单元低于 80 代码行，新增文件符合 800 行上限；没有配置的圈复杂度工具。仅测试构建参与的新模块不进入生产模块图。

声明所有权守卫复用现有 Rust 词法解析器，去除注释/字符串后识别指定能力的函数声明，不断言普通文案或源码布局；它不检测换名字后的相同实现，CPD 和评审继续承担该范围。非 Unix 身份语义、真实 WebView 与既有未建模的配置相关性保持原验证边界。提交与推送仍由版本化钩子重新执行完整门禁；为规避已记录的 linked-worktree 空扫描问题，推送在普通隔离克隆的精确提交树上执行，保留钩子、分类及全部质量门条件。

## 第一阶段验证结果与边界

在仓库根目录、固定 Node 24.18.0 下：

- `npm test -- src/editor/nodes/assetMediaOwnership.test.ts`：实现前明确检测到两个所有者而失败，接入共享 hook 后通过。
- `npm test -- src/editor/nodes/assetMediaOwnership.test.ts src/editor/nodes/useAssetMedia.test.tsx src/editor/nodes/ImageNode.test.tsx src/editor/nodes/ShotNode.test.tsx`：42 项通过，覆盖矩阵所选状态；两节点的原测试未修改。
- `npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build && npm test`：全部通过；全量前端 184 文件 / 2790 项。
- 在 `src-tauri` 执行 `cargo test`：654 项单元测试、5 项叶子集成测试及原生退出目标通过。
- `npm run sonar:gate`：完整通过，重新生成前端/Rust LCOV，分别为 **98.15% / 87.18%**；Vitest 展示行覆盖率为 98.14%，LCOV 与台账按 DA 记录计算。Quality Gate `OK`、新代码未解决问题 0，服务端新代码覆盖率 91.9%。未修改门禁阈值、排除配置或规则。

全量 Vitest 使用其原生环境变量 `VITEST_MAX_WORKERS=4` 控制资源并发；不减少测试或门禁步骤。首次前端全量与 Rust 冷编译同时执行，多个既有脚本测试超过 5 秒超时，已中止该次并发运行；Rust 完成后串行完整重跑通过。构建、扫描和覆盖率的本次临时产物在任务结束时清理，原有覆盖率目录保留。

文档没有配置的自动检查，已按数值、阈值/触发动作、逐项排除条件、状态矩阵和交叉链接进行结构化复核。新添/实质修改的执行单元均低于 80 代码行；圈复杂度为 `N/A — no configured complexity tool`，以跨度和嵌套人工复核。真实 WebView 像素验证未执行，理由及边界见矩阵；所有选定自动验证用例均已通过。
