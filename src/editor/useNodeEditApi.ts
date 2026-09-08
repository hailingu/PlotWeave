/**
 * 节点编辑上下文装配（docs/ui-design.md §4.3 ⚙️ 设置面板 = 节点编辑器）：
 * 把节点组件需要的面板开关、字段补丁、复制/删除与设定集/资产解析源收成
 * NodeEditApi，供 NodeEditContext.Provider 一次性下传。依赖逐项解构，
 * 文档/动作分组对象换引用时不会让整个上下文无谓失效。
 */
import { useMemo } from 'react'
import type { NodeEditApi } from './nodeEdit'
import type { CanvasView } from './useCanvasView'
import type { EditorDocument } from './useEditorDocument'
import type { EditorGraphActions } from './useEditorGraphActions'
import type { EditorPanels } from './useEditorPanels'

/** 组装 NodeEditApi：面板态、节点写动作与解析源逐项取自各域对象。 */
export function useNodeEditApi(
  projectId: string,
  doc: EditorDocument,
  panels: EditorPanels,
  graph: EditorGraphActions,
  view: CanvasView,
): NodeEditApi {
  const { openSettingsId, toggleSettings, closeSettings } = panels
  const { patchNode } = graph.patch
  const { duplicateNode } = graph.creation
  const { deleteNodesByIds } = graph
  const { shotCountOf, beatFulfillmentOf } = view
  const { settings, assets } = doc

  return useMemo<NodeEditApi>(
    () => ({
      projectId,
      openSettingsId,
      toggleSettings,
      closeSettings,
      patchNode,
      duplicateNode,
      deleteNode: (id: string) => deleteNodesByIds([id]),
      shotCountOf,
      beatFulfillmentOf,
      settings,
      assets,
    }),
    [
      projectId,
      openSettingsId,
      toggleSettings,
      closeSettings,
      patchNode,
      duplicateNode,
      deleteNodesByIds,
      shotCountOf,
      beatFulfillmentOf,
      settings,
      assets,
    ],
  )
}
