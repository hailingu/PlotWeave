# PlotWeave

**PlotWeave** 是一个面向短剧创作的可视化画布工具：将剧本、场景、角色与剧情分支组织为可编辑的节点图，在画布上完成从剧本构思到分集叙事的"编织"。产品形态对标 LibTV 这类短剧制作网站。

## 核心概念

- **剧本画布**：以节点表示场景、桥段、对白等叙事单元，以连线表示剧情流向。
- **分支叙事**：短剧常见的多线、反转、多结局结构，通过画布上的分支连线直观编排。
- **设定管理**：角色、道具、场景等设定与画布节点关联，保持剧情一致性。

## 功能规划

- [x] 画布编辑器：节点增删改、连线、缩放与导航
- [x] 剧本节点：场景 / 桥段 / 对白节点的结构化编辑
- [x] 分支与多结局编排
- [x] 角色与设定管理面板
- [x] 剧本导出（Markdown 纯文本，含分镜附录）
- [ ] 画布对齐与吸附
- [ ] 剧本导出：结构化格式（JSON）
- [ ] 画布内 AI 图像生成：角色垫图 / 场景底图 / 分镜关键帧（媒体节点 + job 状态机，详见 `docs/data-model.md` §13）

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | Tauri + React + React Flow（`@xyflow/react`）+ TypeScript |
| 后端 | Rust（Tauri 进程内 commands：数据模型、持久化、剧本解析与导出） |

桌面端由 Tauri 打包，前端负责画布交互，业务逻辑与文件读写下沉到 Rust 侧。

## 仓库结构

```
PlotWeave/
├── .githooks/      # 版本化的提交 / 推送质量门禁
├── scripts/        # SonarQube 门禁及其行为测试
├── src/            # React + React Flow 前端
├── src-tauri/      # Rust 后端与 Tauri 壳（commands、持久化、导出）
├── docs/           # 项目文档（数据模型设计等）
├── AGENTS.md       # AI 代理协作规范
├── README.md
└── LICENSE
```

## 分支模型

`dev` 为**开发基线**，`main` 为集成 / 发布分支，两者均受保护：

- 任务分支一律从当前本地 `dev` 拉出，使用 `feature/`、`fix/`、`docs/`、`chore/` 前缀。
- 任务 PR 一律以 `dev` 为目标；只有来自 `dev` 的集成 / 发布 PR 才可合入 `main`。
- 禁止直接向 `main` 或 `dev` 提交、推送。

```
main ──●─────────────────── 集成 / 发布（受保护）
         \
dev ────●───●───●───●───── 开发基线（受保护）
          \       /
feature/  ●───●  ●──●      任务分支（PR → dev）
```

## 快速开始

```bash
nvm use            # 切换到 .nvmrc 指定的 Node 版本（24.18.0）
npm install        # 安装前端依赖
export SONAR_HOST_URL=http://localhost:9000 # 指向本机实际使用的 SonarQube
export SONAR_TOKEN=your-local-token         # 服务要求认证时设置，替换为本机令牌；也可用 PLOTWEAVE_SONAR_TOKEN（如写入 ~/.zshrc）
npm run hooks:install # 启用版本化的 pre-commit / pre-push hooks
npm run tauri dev  # 启动 Tauri 开发调试（Vite 前端 + Rust 壳）
```

常用校验命令：

- 前端：仓库根目录执行 `npm run lint && npm run build`
- 后端：`src-tauri/` 目录执行 `cargo fmt --check && cargo clippy -- -D warnings && cargo test`

### 提交与推送门禁

仓库使用同一套 `pre-commit` 和 `pre-push` 门禁。启用 hooks 后，每次提交和推送都会依次：

1. 运行 `npm run test:coverage`，生成最新的 `coverage/lcov.info`，并确认报告非空、包含源文件和实际命中行。
2. 运行 `sonar-scanner` 并等待 SonarQube Quality Gate 完成。
3. 确认 Quality Gate 为 `OK`，且项目未解决问题总数为 `0`。

本机需安装 `sonar-scanner`，并在执行 Git 操作的终端环境中显式设置 `SONAR_HOST_URL`；这样可以避免新版扫描器在地址缺失时误连 SonarQube Cloud。服务需要认证时，通过本机环境变量 `SONAR_TOKEN` 提供令牌；未设置 `SONAR_TOKEN` 时回退读取 `PLOTWEAVE_SONAR_TOKEN`（可导出在 `~/.zshrc` 中，Git 钩子继承调用方终端的环境）。地址按本机环境配置，令牌禁止写入仓库。也可以用 `npm run sonar:gate` 手动执行完整门禁。

测试失败、覆盖率报告无效、扫描失败、Quality Gate 未通过、服务不可用或仍有任何未解决问题时，Git 操作会被阻止。同一工作树只允许一个门禁运行，以免并发扫描覆盖共享产物。应逐项修复并重复执行门禁，直到问题数归零；不得使用 `--no-verify` 绕过。

## 文档与协作

- AI 代理（ZCode / Codex 等）开始任何工作前，先阅读 [AGENTS.md](AGENTS.md)。
- 项目文档使用中文。

## 许可证

[MIT](LICENSE)
