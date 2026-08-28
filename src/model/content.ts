/**
 * 会话文档：编辑器运行态的项目内容（docs/data-model.md v1 §2——画布状态
 * 唯一真源在编辑器会话内，ProjectDocument 只是它的序列化形态）。
 * 与落盘格式的互转见 convert.ts；类型引用 React Flow 仅为对齐运行态形状。
 */
import type { Edge, Viewport } from '@xyflow/react'
import type { CanvasNode } from '../editor/nodes/types'
import type { ProjectSettings } from '../editor/settings'

/** 项目会话内容：名称 + 创建时间 + 画布两数组 + 设定集 + 集标题 + 视口。 */
export interface ProjectContent {
  name: string
  /** ISO 8601；新建项目缺省时首次落盘补盖。 */
  createdAt?: string
  nodes: CanvasNode[]
  edges: Edge[]
  settings: ProjectSettings
  /** 集 = 编号 + 大纲行内标题（§4.1，不建集实体表）；缺省视为无命名集。 */
  episodeTitles?: Record<number, string>
  /** 视口随文档持久化（§3）；缺省时打开后 fitView。 */
  viewport?: Viewport
}
