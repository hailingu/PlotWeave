/**
 * 编辑器会话文档构建（EditorView 防抖落盘与视口标脏共用）。
 * project 元信息（name/description/createdAt）是编辑器不编辑的透传字段，
 * 每次构建都必须原样携带，漏带即保存丢数据（§3/§7.1）；资产索引是
 * 会话态（§7.3 库资产拖上画布在会话内新增），从 part 取编辑器当前状态。
 */
import type { Edge, Viewport } from '@xyflow/react'
import type { CanvasNode } from './nodes/types'
import type { ProjectSettings } from './settings'
import type { AssetRef } from '../model/document'

/** 编辑器项目属性：App 传入的完整会话项目（含透传字段）。 */
export interface EditorProject {
  id: string
  name: string
  /** 透传字段：上游可显式 undefined（= 缺省；构建原样携带后由序列化
   * 剥离，issue #231）。 */
  description?: string | undefined
  createdAt?: string | undefined
  assets?: { byId: Record<string, AssetRef> } | undefined
  /** 同版本文档的容器级扩展字段透传（issue #100 字段演进策略，§11）：
   * 与 name/description 同为编辑器不编辑的透传字段，每次构建必须原样
   * 携带，漏带即防抖保存丢数据（评审 P1）。 */
  // 透传扩展字段可显式 undefined = 无扩展（issue #231）
  graphExtensions?: Record<string, unknown> | undefined
  settingsExtensions?: Record<string, unknown> | undefined
  assetsExtensions?: Record<string, unknown> | undefined
}

/** 画布可变部分：节点/边/设定集/集标题/视口/资产索引来自编辑器状态。 */
export interface SessionDocPart {
  nodes: CanvasNode[]
  edges: Edge[]
  settings: ProjectSettings
  /** 可显式 undefined（= 缺省；视口未落定/无命名集，issue #231）。 */
  episodeTitles?: Record<number, string> | undefined
  viewport?: Viewport | undefined
  /** 已应用 AI 批次计数（§12.2 提交身份）；0/缺省不落盘。 */
  aiRevision?: number | undefined
  /** 会话内资产索引（含本会话导入的条目）；undefined = 无资产桶。 */
  assets: EditorProject['assets']
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
    ...(part.aiRevision ? { aiRevision: part.aiRevision } : {}),
    assets: part.assets,
    // 同版本文档的容器级扩展字段随会话透传（issue #100，§11）；缺省省略
    ...(project.graphExtensions
      ? { graphExtensions: project.graphExtensions }
      : {}),
    ...(project.settingsExtensions
      ? { settingsExtensions: project.settingsExtensions }
      : {}),
    ...(project.assetsExtensions
      ? { assetsExtensions: project.assetsExtensions }
      : {}),
  }
}
