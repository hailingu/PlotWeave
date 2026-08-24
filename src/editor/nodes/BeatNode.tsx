import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { BeatFlowNode } from './types'

/**
 * 桥段节点 = 节奏拍点胶囊（docs/ui-design.md §4.2，片场族深色）。
 * 卡在剧情流上的最窄最暗胶囊：⚡ + 名称 + 情绪基调 + 常驻 ⚙️，无展开身体。
 */
export default function BeatNode({ data, selected }: NodeProps<BeatFlowNode>) {
  return (
    <div className={`pw-beat${selected ? ' pw-on' : ''}`}>
      <span aria-hidden>⚡</span>
      <span>{data.name}</span>
      <span className="pw-beat-tone">基调：{data.tone}</span>
      <button type="button" className="pw-gear" aria-label="桥段设置">
        ⚙️
      </button>
      <Handle type="target" position={Position.Left} className="pw-port" />
      <Handle type="source" position={Position.Right} className="pw-port" />
    </div>
  )
}
