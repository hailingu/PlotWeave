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

## 验证结果与边界

在仓库根目录、固定 Node 24.18.0 下：

- `npm test -- src/editor/nodes/assetMediaOwnership.test.ts`：实现前明确检测到两个所有者而失败，接入共享 hook 后通过。
- `npm test -- src/editor/nodes/assetMediaOwnership.test.ts src/editor/nodes/useAssetMedia.test.tsx src/editor/nodes/ImageNode.test.tsx src/editor/nodes/ShotNode.test.tsx`：42 项通过，覆盖矩阵所选状态；两节点的原测试未修改。
- `npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build && npm test`：全部通过；全量前端 184 文件 / 2790 项。
- 在 `src-tauri` 执行 `cargo test`：654 项单元测试、5 项叶子集成测试及原生退出目标通过。
- `npm run sonar:gate`：完整通过，重新生成前端/Rust LCOV，分别为 **98.15% / 87.18%**；Vitest 展示行覆盖率为 98.14%，LCOV 与台账按 DA 记录计算。Quality Gate `OK`、新代码未解决问题 0，服务端新代码覆盖率 91.9%。未修改门禁阈值、排除配置或规则。

全量 Vitest 使用其原生环境变量 `VITEST_MAX_WORKERS=4` 控制资源并发；不减少测试或门禁步骤。首次前端全量与 Rust 冷编译同时执行，多个既有脚本测试超过 5 秒超时，已中止该次并发运行；Rust 完成后串行完整重跑通过。构建、扫描和覆盖率的本次临时产物在任务结束时清理，原有覆盖率目录保留。

文档没有配置的自动检查，已按数值、阈值/触发动作、逐项排除条件、状态矩阵和交叉链接进行结构化复核。新添/实质修改的执行单元均低于 80 代码行；圈复杂度为 `N/A — no configured complexity tool`，以跨度和嵌套人工复核。真实 WebView 像素验证未执行，理由及边界见矩阵；所有选定自动验证用例均已通过。
