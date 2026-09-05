import { useId } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useInternalNode,
  useStore,
  type EdgeProps,
  type Edge,
} from '@xyflow/react'
import { branchOptionIdOf } from '../graphRules'
import type { CanvasNode } from '../nodes/types'

/** 分支连线数据：运行态仅保留可选排序（§4.4）。胶囊文案不落镜像——
 * BranchEdge 按 sourceHandle 绑定的选项 id 从源分支节点 options 实时
 * 派生（issue #18：改名/撤销/重做的会话内新鲜度，单一真相源）。 */
export interface BranchEdgeData extends Record<string, unknown> {
  order?: number
}

export type BranchFlowEdge = Edge<BranchEdgeData, 'branch'>

/**
 * 分支连线（docs/ui-design.md §4.4）：品牌渐变描边的贝塞尔曲线 +
 * 线中点选项胶囊。文案经 useInternalNode 订阅源分支节点实时派生——
 * 源缺失/非分支/悬空句柄（指向已删选项）回退空串，胶囊隐藏。
 * 渐变以各边独立 id 的 linearGradient 定义，引用品牌色语义令牌。
 */
export default function BranchEdge({
  id,
  source,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
}: EdgeProps<BranchFlowEdge>) {
  const gradientId = `pw-branch-g-${useId().replace(/:/g, '')}`
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })
  // sourceHandle 不在 EdgeProps 的 Pick 集内：经 store 的 edgeLookup 取
  // （订阅粒度为该边句柄变更，改名不经过此处）
  const sourceHandle = useStore((s) => s.edgeLookup.get(id)?.sourceHandle)
  const userNode = useInternalNode<CanvasNode>(source)?.internals.userNode
  const options = userNode?.type === 'branch' ? userNode.data.options : undefined
  const optionLabel =
    options?.find((o) => o.id === branchOptionIdOf(sourceHandle))?.label ?? ''

  return (
    <>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--accent-alt)" />
          <stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
      </defs>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{ stroke: `url(#${gradientId})`, strokeWidth: 1.5 }}
      />
      {optionLabel && (
        <EdgeLabelRenderer>
          <div
            className="pw-edge-label"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {optionLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
