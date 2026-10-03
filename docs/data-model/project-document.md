# 数据模型：项目文档

[返回数据模型索引](README.md) · 相关主题：[图模型](graph-model.md)、[加载与归一化](normalization.md)

## 三、ProjectDocument

一个项目一份文档，序列化为 `project.json`：

```ts
/** 项目文档：画布数据的序列化真源。 */
interface ProjectDocument {
  schemaVersion: 1
  project: {
    id: string            // 目录名，创建时生成的 UUID
    name: string
    description?: string
    createdAt: string     // ISO 8601
    updatedAt: string
  }
  graph: {
    nodes: StoryNode[]    // 见第四节
    edges: StoryEdge[]    // 见第五节
    viewport?: { x: number; y: number; zoom: number }  // 单用户场景直接随文档持久化；缺省 = 从未保存过视口（打开时 fitView）
    aiRevision?: number   // 已应用 AI 批次的单调计数（§12.2 提交身份）；缺省 = 0，只增不减
  }
  settings: {             // 设定集：节点通过 id 引用，见第六节
    characters: Record<string, Character>
    locations: Record<string, Location>
    props: Record<string, PropItem>
    documents: Record<string, SettingsDocument>  // 长篇自由文本条目（小传/世界观/术语表）
  }
  episodeTitles: Record<number, string>  // 集标题表：键 = 集号（见 4.1，不建「集」实体表）
  assets: {
    byId: Record<string, AssetRef>  // 项目资产索引；文件本体在项目 assets/ 目录，见第七节
  }
}
```

文档**不**持久化画布会话态：撤销/重做栈、选中态（`ui.selected` 加载时重置）、拖拽中的临时位置。这些留在内存，随会话结束消失。创作型 AI 对话是例外：它不进入 `ProjectDocument`，而是按 §10.1 的独立 `ai-session.json` 保存，以免频繁消息写入重序列化整份画布。

前端 `ProjectDocument` 类型的 `schemaVersion` 成员收窄为 `CURRENT_SCHEMA_VERSION` 的字面量类型（`CurrentSchemaVersion`，[issue #312](https://github.com/hailingu/PlotWeave/issues/312)）：本类型只描述**归一化后的当前格式**，序列化与归一化两处构造点恒写当前版本，0/2 等其他版本在编译期即被拒绝静态构造（编译期契约探针见 `src/model/typeContracts.test-d.ts`）；未信任/旧版本输入不在本类型的表达范围内，其版本判型与 v0→v1 迁移收口在归一化入口 `parseProject` 的 unknown 原始边界（§11.1）。

`graph`/`settings`/`assets` 三个容器可携带上表契约键之外的**同版本扩展字段**（未知键，[issue #100](https://github.com/hailingu/PlotWeave/issues/100)）：Rust 原样透传、前端归一化按扩展字段保留（不修复、不回写），保存原样落盘——数值须为 IEEE 754 双精度可往返形态才受保留保证：整数越出 JS 安全整数域可诊断（归一化记警告、保存固化当前加载值）；小数精度超出 f64 的值在 Rust 解析侧即舍入、webview 不可检测，同样不受保证（§11 分层策略与传输边界）。顶层与 `project` 层是类型化封闭契约，未知键不保留；会被旧客户端丢弃的字段增补必须升级 `schemaVersion`。

### 3.1 结构化剧本导出（JSON）

导出对话框的 JSON 格式直接使用 `ProjectDocument v1`，由 `sessionDoc` 汇集当前编辑器会话（包括尚未自动保存的编辑），再经已有 `serializeProject` 转换。它与项目保存共用节点、连线、设定、分集标题、资产索引和容器扩展的序列化规则，不维护第二套剧本 schema；项目 id、名称、描述与创建时间保留，`updatedAt` 保留加载文档的规范化修改时间，不再作为导出戳记（[issue #501](https://github.com/hailingu/PlotWeave/issues/501)）。`parseProject` 将该值透传进 `ProjectContent`，应用层经项目元数据显式传给纯生成器；导出不读取系统时钟，同一会话在不同时刻导出的 JSON 字节一致，`JSON → parseProject → 再导出` 保持不动点。兼容调用缺少 `updatedAt` 时取 `createdAt`，两者均缺省时固定取 epoch；正常加载及内存新建项目均携带时间元数据。

Markdown 与 JSON 均使用可复现口径：编辑器不向 Markdown 头部注入当前日期，仅保留出处行；既有 Markdown 生成器仍接受可选、显式的日期文案（#360），编辑器不使用该参数。JSON 中的时间是文档元数据，不增加 `exportedAt` 字段。保存仍按保存时刻更新 `updatedAt`；本次不接入保存权威回执，会话携带的是加载基线时间，尚未保存的编辑及本次会话内保存不会刷新这份元数据。消费保存回执刷新会话的演进边界仍见 [持久化 §10.5](persistence.md#105-rust-持久化命令tauri-commands) 与 #268。

JSON 包含所有节点类型、全部分支选项与三种连线，以及布局、视口和已有的 AI 批次计数；不按 Markdown 正文的线性叙事范围裁剪。节点选择等 UI 状态使用序列化器的默认值，React Flow 拖动与测量字段、撤销历史不进入文档。导出只读会话，不触发保存或历史命令。

视口使用最近一次 `onMoveEnd` 发布的完成值：若打开导出时画布平移、缩放或适配动画尚未结束，完成后自动刷新 JSON，预览、后续复制／下载与保存输入保持一致（[PR #489 评审修复](https://github.com/hailingu/PlotWeave/pull/489#discussion_r4167711466)）。同步保存镜像仍在事件内更新，保证完成事件与退出发生在同批时也能冲刷最终视口；相同坐标的重复事件不重建导出文本。

文件以 UTF-8、两空格缩进输出，使用 `.json` 扩展名与 `application/json` MIME。媒体仍是 `assets.byId` 中的引用，文件本体和独立的 `ai-session.json` 不包含在内，因此 JSON 不是完整媒体备份包。此功能不增加文件导入入口；格式回读使用现有解析器验证，交互及状态矩阵见 [UI 规格 §3.7](../ui-design.md#37-对齐吸附与-json-导出的状态回归矩阵)。
