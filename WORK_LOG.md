# 清理已被 issue 覆盖的任务记录文档

## 基线与授权

- 授权：用户在第六轮质量评估交付后询问 docs 下可移除的文档（"有些可以通过已经创建和处理过的 issue 覆盖"），经引用图盘点与两问确认，选定**仅低风险批次**：内容已被已关闭 issue 覆盖、引用面小的任务记录；证据类历史文档（p1/p2/p5-evidence、pr526-fixes、feature-parity）按用户决定保留，`docs/testing/*-ub-review.json` 保留（本地 ub-mode 台账按 sha256 校验其入库半边）。
- 基线：`origin/develop` @ `664b89f9`（PR #961 合并提交）；任务分支 `docs/prune-task-record-docs`。

## 移除清单（11 个 tracked 文件 + 本地 .DS_Store）

- `docs/swiftui-react-flow-integration.md` —— 2026-10-07 一次性集成记录，改由 PR #526 链接承载。
- `docs/data-model-revisions.md` —— 自述历史归档（issue #236 移入），现行契约以 `data-model/` 为准。
- `docs/development/library-import-716.md` —— #716 已关闭的任务记录。
- `docs/testing/issue-{929,931,939,941,946,948}-*.md`、`issues-744-928-932-native-ui.md`、`issues-945-949-ci.md` —— 8 个已关闭 issue 的工作记录，结论在 issue 本体。
- `docs/.DS_Store` —— 未被 git 跟踪（.gitignore:50 已覆盖），仅本地删除。

## 引用改写（14 处，全部改为 GitHub issue/PR 绝对链接）

- 合入记录 4 处 → PR #526：migration-plan.md:198、toolchain.md:3、feature-parity.md:9、development/workflow.md:70。
- 修订历史 3 处 → 移除/收敛至 design-sync + issue #236 注记：data-model.md:5、data-model/README.md:4、README.md:28。
- 验证记录 7 处 → 对应 issue：assets.md:100（#716）、ui-design.md:485/487/796（#929/#939/#931/#744）、ai-integration.md:29/31（同上）、ub-mode-gate.md:63（#941）、design-sync.md:58 与 normalization.md:49（#946）、feature-parity.md:792（#744）。

## 验证

- 残留扫描：11 个被删文件名在 docs/src/native/scripts/.github/.githooks/AGENTS/README 中引用为 0（排除 ub-review.json）。
- 全 docs 相对链接目标扫描：0 断链。
- `npx prettier --check docs/`：全部通过。
- check-docs.sh 在 pre-push 对 base..head 运行；本变更为编辑性文档清理，无可执行单元，不适用 Red-Green-Refactor。

## 发布流程

正常 commit hooks 完整门禁 → `npm run ub:check -- <base> docs/testing/docs-prune-ub-review.json` → 推送（docs 范围）→ `npm run pr:create` → CI 四项 → 合并 develop → 清理分支。
