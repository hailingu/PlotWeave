# PlotWeave

**PlotWeave** 是一个面向短剧创作的可视化画布工具：将剧本、场景、角色与剧情分支组织为可编辑的节点图，在画布上完成从剧本构思到分集叙事的"编织"。产品形态对标 LibTV 这类短剧制作网站。

## 核心概念

- **剧本画布**：以节点表示场景、桥段、对白等叙事单元，以连线表示剧情流向。
- **分支叙事**：短剧常见的多线、反转、多结局结构，通过画布上的分支连线直观编排。
- **设定管理**：角色、道具、场景等设定与画布节点关联，保持剧情一致性。

## 功能规划

- [ ] 画布编辑器：节点增删改、连线、对齐、缩放与导航
- [ ] 剧本节点：场景 / 桥段 / 对白节点的结构化编辑
- [ ] 分支与多结局编排
- [ ] 角色与设定管理面板
- [ ] 剧本导出（纯文本 / 结构化格式）

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | Tauri + React + React Flow（`@xyflow/react`）+ TypeScript |
| 后端 | Rust（Tauri 进程内 commands：数据模型、持久化、剧本解析与导出） |

桌面端由 Tauri 打包，前端负责画布交互，业务逻辑与文件读写下沉到 Rust 侧。

## 仓库结构

```
PlotWeave/
├── src/            # React + React Flow 前端
├── src-tauri/      # Rust 后端与 Tauri 壳（commands、持久化、导出）
├── docs/           # 项目文档（待补充）
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
npm run tauri dev  # 启动 Tauri 开发调试（Vite 前端 + Rust 壳）
```

常用校验命令：

- 前端：仓库根目录执行 `npm run lint && npm run build`
- 后端：`src-tauri/` 目录执行 `cargo fmt --check && cargo clippy -- -D warnings && cargo test`

## 文档与协作

- AI 代理（ZCode / Codex 等）开始任何工作前，先阅读 [AGENTS.md](AGENTS.md)。
- 项目文档使用中文。

## 许可证

[MIT](LICENSE)
