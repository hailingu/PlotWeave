/**
 * 编辑器会话文档构建（EditorView 防抖落盘与视口标脏共用）。
 * project 元信息与资产桶是编辑器不编辑的透传字段：每次构建都必须
 * 原样携带（description / assets），漏带即保存丢数据（§3/§7.1）。
 */
import type { Edge, Viewport } from '@xyflow/react'
import type { CanvasNode } from './nodes/types'
import type { ProjectSettings } from './settings'
import type { AssetRef } from '../model/document'

/** 编辑器项目属性：App 传入的完整会话项目（含透传字段）。 */
export interface EditorProject {
  id: string
  name: string
  description?: string
  createdAt?: string
  assets?: { byId: Record<string, AssetRef> }
}

/** 画布可变部分：节点/边/设定集/集标题/视口来自编辑器状态。 */
export interface SessionDocPart {
  nodes: CanvasNode[]
  edges: Edge[]
  settings: ProjectSettings
  episodeTitles?: Record<number, string>
  viewport?: Viewport
}

/** 构建传给 useDebouncedSave / markDirty 的会话文档。 */
export function sessionDoc(project: EditorProject, part: SessionDocPart) {
  return {
    name: project.name,
    createdAt: project.createdAt,
    description: project.description,
    nodes: part.nodes,
    edges: part.edges,
    settings: part.settings,
    episodeTitles: part.episodeTitles,
    viewport: part.viewport,
    assets: project.assets,
  }
}
