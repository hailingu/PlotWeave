/**
 * 会话文档：编辑器运行态的项目内容（docs/data-model.md v1 §2——画布状态
 * 唯一真源在编辑器会话内，ProjectDocument 只是它的序列化形态）。
 * 与落盘格式的互转见 convert.ts；节点/边/设定集类型为本域自有
 * （session.ts/settings.ts，issue #353 方向一），编辑器运行态与之结构兼容。
 */
import type { AssetRef, Viewport } from './document'
import type { SessionEdge, SessionNode } from './session'
import type { ProjectSettings } from './settings'

/** 项目会话内容：名称 + 创建时间 + 画布两数组 + 设定集 + 集标题 + 视口。
 * description / assets 为编辑器首版不编辑的透传字段：解析进会话、
 * 保存原样回写，否则已有描述或资产的项目一保存即丢（§3/§7.1）。 */
export interface ProjectContent {
  name: string
  /** 项目描述（§3 project.description，透传）。 */
  description?: string | undefined
  /** ISO 8601；新建项目缺省时首次落盘补盖（副本显式 undefined =
   * 不继承创建时间，落盘补盖）。 */
  createdAt?: string | undefined
  nodes: SessionNode[]
  edges: SessionEdge[]
  settings: ProjectSettings
  /** 集 = 编号 + 大纲行内标题（§4.1，不建集实体表）；缺省/显式 undefined
   * 视为无命名集（issue #231）。 */
  episodeTitles?: Record<number, string> | undefined
  /** 视口随文档持久化（§3）；缺省时打开后 fitView。 */
  viewport?: Viewport | undefined
  /** 已应用 AI 批次的单调计数（§12.2 提交身份）；缺省 = 0。 */
  aiRevision?: number | undefined
  /** 项目资产索引透传（缺省 = 无资产；可显式 undefined，issue #231）。 */
  assets?: { byId: Record<string, AssetRef> } | undefined
  /** 同版本文档的容器级扩展字段透传（issue #100 字段演进策略，§11）：
   * schemaVersion 不变的未来字段增补出现在 graph/settings/assets 容器时
   * 按未知键原样保留——解析不修复、不警告、不回写，保存原样落盘。
   * 缺省 = 无扩展字段。顶层与 project 层是封闭契约，不在保留范围。 */
  graphExtensions?: Record<string, unknown> | undefined
  settingsExtensions?: Record<string, unknown> | undefined
  assetsExtensions?: Record<string, unknown> | undefined
}
