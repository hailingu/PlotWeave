/**
 * 节点创建与复制（EditorView 拆出的节点写域，docs/ui-design.md §3.3）：
 * buildNewNode 只构建不入状态（手动创建与 ✦AI 批量创建共用，编号基线可
 * 注入以防批量连续创建重号），createNode 入状态并单步入栈可撤销，
 * duplicateNode 以同 data 新 id 右下偏移并只选中副本。纯构建见 nodeFactory。
 */
import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { XYPosition } from '@xyflow/react'
import { buildCanvasNode } from './nodeFactory'
import type { CreatableType } from './creatable'
import type { EditorDocument } from './useEditorDocument'
import type { HistoryCommand } from './history'
import type { CanvasNode } from './nodes/types'

/** 复制副本的落点偏移（像素）：右下错开，避免与源节点完全重叠。 */
const DUPLICATE_OFFSET = { x: 48, y: 40 }

/** buildNewNode 可选项：落点/选中/字段覆盖与编号基线。 */
export interface NewNodeOptions {
  at?: XYPosition
  selected?: boolean
  data?: Record<string, unknown>
  /** 编号基线列表；批量连续创建时传模拟数组防止编号重复。 */
  against?: CanvasNode[]
}

/** 节点创建动作组。 */
export interface NodeCreationActions {
  /** 构建节点对象（不入状态、不入栈）。 */
  buildNewNode: (type: CreatableType, opts?: NewNodeOptions) => CanvasNode
  /** ＋节点/拖放生成：构建 → 入状态 → 单步入栈。 */
  createNode: (
    type: CreatableType,
    opts?: { at?: XYPosition; data?: Record<string, unknown> },
  ) => void
  /** ⧉ 复制：同 data 新 id，右下偏移并只选中新副本；入栈可撤销。 */
  duplicateNode: (id: string) => void
}

/** useNodeCreation 的依赖注入：文档写通道、落点换算与浮层收起。 */
export interface NodeCreationDeps {
  doc: EditorDocument
  setPlusOpen: Dispatch<SetStateAction<boolean>>
  closeSettings: () => void
  screenToFlowPosition: (pos: { x: number; y: number }) => XYPosition
  /** 画布容器：无显式落点时取其视口中心作为新节点位置。 */
  canvasRef: { current: HTMLDivElement | null }
  pushHistory: (cmd: HistoryCommand) => void
}

/** 以文档写通道实现新建/复制节点。 */
export function useNodeCreation(deps: NodeCreationDeps): NodeCreationActions {
  const { doc, setPlusOpen, closeSettings, screenToFlowPosition, canvasRef, pushHistory } = deps
  const { nodesRef, setNodes, settings } = doc

  const buildNewNode = useCallback(
    (type: CreatableType, opts?: NewNodeOptions): CanvasNode => {
      const rect = opts?.at ? undefined : canvasRef.current?.getBoundingClientRect()
      const center = rect
        ? screenToFlowPosition({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          })
        : null
      return buildCanvasNode(type, opts, {
        against: opts?.against ?? nodesRef.current,
        characters: settings.characters,
        center,
      })
    },
    [canvasRef, nodesRef, screenToFlowPosition, settings.characters],
  )

  const createNode = useCallback(
    (type: CreatableType, opts?: { at?: XYPosition; data?: Record<string, unknown> }) => {
      const node = buildNewNode(type, { at: opts?.at, selected: true, data: opts?.data })
      setNodes((all) => [...all.map((n) => ({ ...n, selected: false })), node])
      pushHistory({
        undo: () => setNodes((all) => all.filter((n) => n.id !== node.id)),
        redo: () => setNodes((all) => [...all, node]),
      })
      setPlusOpen(false)
      closeSettings()
    },
    [buildNewNode, closeSettings, pushHistory, setNodes, setPlusOpen],
  )

  const duplicateNode = useCallback(
    (id: string) => {
      const src = nodesRef.current.find((n) => n.id === id)
      if (!src) return
      const copy = {
        ...src,
        id: `${src.type}-${Date.now()}`,
        position: {
          x: src.position.x + DUPLICATE_OFFSET.x,
          y: src.position.y + DUPLICATE_OFFSET.y,
        },
        selected: true,
        data: { ...src.data },
      } as CanvasNode
      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), copy])
      pushHistory({
        undo: () => setNodes((nds) => nds.filter((n) => n.id !== copy.id)),
        redo: () => setNodes((nds) => [...nds, copy]),
      })
      closeSettings()
    },
    [closeSettings, nodesRef, pushHistory, setNodes],
  )

  return { buildNewNode, createNode, duplicateNode }
}
