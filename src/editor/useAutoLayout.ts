/**
 * 自动排布动作 hook（issue #94）：把 computeAutoLayout 的结果作为**一次**
 * 撤销单元应用——排布前全量位置快照入 undo、排布结果入 redo，与节点拖拽
 * 历史（useNodeDragHistory）同一快照语义。无位置变化不入栈；计算失败保留
 * 原布局并上浮可读反馈；成功后适配视图让用户看到整理结果（视图操作不入栈）。
 */
import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type { Edge, FitView, XYPosition } from '@xyflow/react'
import { computeAutoLayout, hasUsableSize, type LayoutEdge } from './autoLayout'
import type { HistoryCommand } from './history'
import type { CanvasNode } from './nodes/types'

/** useAutoLayout 的依赖注入：文档镜像 ref、写通道、命令栈、视口与错误上浮。 */
export interface AutoLayoutDeps {
  nodesRef: MutableRefObject<CanvasNode[]>
  edgesRef: MutableRefObject<Edge[]>
  setNodes: Dispatch<SetStateAction<CanvasNode[]>>
  pushHistory: (cmd: HistoryCommand) => void
  /** 排布完成后的视图适配（成功路径独享）。 */
  fitView: FitView
  /** 计算失败的瞬态诊断上浮（与拖放导入失败同一横幅槽）。 */
  onError: (message: string) => void
  /** 布局计算入口：默认纯函数实现，测试与算法演进可替换。 */
  computeLayout?: typeof computeAutoLayout
}

/** 视口适配的动画节奏：与大纲定位一致；「减少动态」偏好下降级为无插值
 * 即时适配（§2.6，CSS 媒体查询管不到 JS 动画，PR #111 评审）。 */
const FIT_DURATION_MS = 400
const FIT_OPTIONS = { padding: 0.15, maxZoom: 1 }

const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** 自动排布动作：无变化与失败都是安全无操作，成功才有历史与视图副作用。 */
export function useAutoLayout(deps: AutoLayoutDeps) {
  const { nodesRef, edgesRef, setNodes, pushHistory, fitView, onError } = deps
  const compute = deps.computeLayout ?? computeAutoLayout

  const onAutoLayout = useCallback(() => {
    const nodes = nodesRef.current
    if (nodes.length === 0) return
    // 尺寸测量未完成的节点（实测/落盘均无宽高，如 max-content 节拍卡）
    // 回退尺寸不可信：等待测量而非提交可能重叠的布局（issue #94 验收标准）
    if (!nodes.every(hasUsableSize)) {
      onError('部分节点尚未完成尺寸测量，已保留原布局，请稍后重试')
      return
    }
    const before = new Map(nodes.map((n) => [n.id, { ...n.position }]))
    let after: Map<string, XYPosition>
    try {
      after = compute(nodes, edgesRef.current as LayoutEdge[])
    } catch (err) {
      onError(
        `自动排布失败：${err instanceof Error ? err.message : String(err)}，已保留原布局`,
      )
      return
    }
    const moved = nodes.some((n) => {
      const p = after.get(n.id)
      return p !== undefined && (p.x !== n.position.x || p.y !== n.position.y)
    })
    if (!moved) return
    const apply = (positions: Map<string, XYPosition>) =>
      setNodes((nds) =>
        nds.map((n) => {
          const p = positions.get(n.id)
          return p ? { ...n, position: { ...p } } : n
        }),
      )
    pushHistory({ undo: () => apply(before), redo: () => apply(after) })
    apply(after)
    // setNodes 是 React 状态：React Flow 内部仓库在提交后才有新位置，
    // fitView 经下一帧调度读到的才是排布后的包围盒
    window.requestAnimationFrame(() =>
      fitView({
        ...FIT_OPTIONS,
        duration: prefersReducedMotion() ? 0 : FIT_DURATION_MS,
      }),
    )
  }, [compute, edgesRef, fitView, nodesRef, onError, pushHistory, setNodes])

  return { onAutoLayout }
}
