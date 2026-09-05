import { createContext, useContext } from 'react'
import type { BeatFulfillment } from './outline'
import type { ProjectSettings } from './settings'
import type { NodeDataPatch } from './nodes/patch'
import type { ProjectContent } from '../model/content'

/**
 * 节点编辑上下文（docs/ui-design.md §4.3 ⚙️ 设置面板 = 节点编辑器）。
 * EditorView 持有全部实现（编辑即命令：实时 patch，无保存按钮；
 * 全部写操作经命令栈可撤销/重做）；节点组件经此上下文触发面板开关、
 * 字段补丁与复制/删除，并读取设定集解析实体引用（§5）。
 */
export interface NodeEditApi {
  /** 当前项目 id：节点渲染解析项目资产媒体（分镜引用位缩略图，§7.1）。 */
  projectId: string
  /** 当前展开设置面板的节点 id；null = 全部收起。 */
  openSettingsId: string | null
  /** ⚙️ 点击：开 ↔ 关（同一节点再点收起）。 */
  toggleSettings: (id: string) => void
  closeSettings: () => void
  /** 编辑即命令：实时合并字段补丁（按节点类型判别绑定，issue 16）。 */
  patchNode: (id: string, cmd: NodeDataPatch) => void
  /** ⧉ 复制：同 data 新 id，右下偏移并只选中新副本。 */
  duplicateNode: (id: string) => void
  /** 🗑 删除：移除节点及其全部连线（撤销能力随命令栈任务补齐）。 */
  deleteNode: (id: string) => void
  /** 索引卡的分镜计数：派生自该场 attach 下挂边数量（§7.2，不落镜像字段）。 */
  shotCountOf: (id: string) => number
  /** 节拍兑现状态（§3.5）：sequence 邻接派生；非节拍 id 返回 null。 */
  beatFulfillmentOf: (id: string) => BeatFulfillment | null
  /** 项目设定集：节点渲染实体引用（角色头像/地点名）的解析源（§5）。 */
  settings: ProjectSettings
  /** 项目资产索引（会话态：§7.3 库资产导入在会话内新增）：分镜引用位的
   * 资产解析源（§7.1/§8.1——引用位 kind 与资产 MIME 家族的编辑边界校验、
   * 缩略图渲染）。 */
  assets: ProjectContent['assets']
}

export const NodeEditContext = createContext<NodeEditApi | null>(null)

/** 节点组件内取编辑能力的 hook；必须在 NodeEditContext.Provider 内使用。 */
export function useNodeEdit(): NodeEditApi {
  const ctx = useContext(NodeEditContext)
  if (!ctx) {
    throw new Error('useNodeEdit 必须在 NodeEditContext.Provider 内使用')
  }
  return ctx
}
