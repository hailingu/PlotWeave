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

`graph`/`settings`/`assets` 三个容器可携带上表契约键之外的**同版本扩展字段**（未知键，[issue #100](https://github.com/hailingu/PlotWeave/issues/100)）：Rust 原样透传、前端归一化按扩展字段保留（不修复、不回写），保存原样落盘——数值须为 IEEE 754 双精度可往返形态才受保留保证：整数越出 JS 安全整数域可诊断（归一化记警告、保存固化当前加载值）；小数精度超出 f64 的值在 Rust 解析侧即舍入、webview 不可检测，同样不受保证（§11 分层策略与传输边界）。顶层与 `project` 层是类型化封闭契约，未知键不保留；会被旧客户端丢弃的字段增补必须升级 `schemaVersion`。
