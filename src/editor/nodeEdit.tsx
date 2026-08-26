import { createContext, useContext } from 'react'

/**
 * 节点编辑上下文（docs/ui-design.md §4.3 ⚙️ 设置面板 = 节点编辑器）。
 * EditorView 持有全部实现（编辑即命令：实时 patch，无保存按钮；
 * 全部写操作经命令栈可撤销/重做）；节点组件经此上下文触发面板开关、
 * 字段补丁与复制/删除。
 */
export interface NodeEditApi {
  /** 当前展开设置面板的节点 id；null = 全部收起。 */
  openSettingsId: string | null
  /** ⚙️ 点击：开 ↔ 关（同一节点再点收起）。 */
  toggleSettings: (id: string) => void
  closeSettings: () => void
  /** 实时合并字段补丁到节点 data（编辑即命令）。 */
  patchNode: (id: string, patch: Record<string, unknown>) => void
  /** ⧉ 复制：同 data 新 id，位置右下偏移并选中新副本。 */
  duplicateNode: (id: string) => void
  /** 🗑 删除：移除节点及其全部连线（撤销能力随命令栈任务补齐）。 */
  deleteNode: (id: string) => void
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
