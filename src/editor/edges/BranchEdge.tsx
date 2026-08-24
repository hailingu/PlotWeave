import { useId } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
  type Edge,
} from '@xyflow/react'

/** 分支连线数据：选项胶囊文案，与分支节点选项同源（不落第二份拷贝）。 */
export interface BranchEdgeData extends Record<string, unknown> {
  optionLabel: string
}

export type BranchFlowEdge = Edge<BranchEdgeData, 'branch'>

/**
 * 分支连线（docs/ui-design.md §4.4）：品牌渐变描边的贝塞尔曲线 +
 * 线中点选项胶囊（文案来自 data.optionLabel）。
 * 渐变以各边独立 id 的 linearGradient 定义，引用品牌色语义令牌。
 */
export default function BranchEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
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
      {data?.optionLabel && (
        <EdgeLabelRenderer>
          <div
            className="pw-edge-label"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {data.optionLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
