import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { BeatFlowNode } from './types'

/**
 * 节奏卡 = 节拍胶囊（docs/ui-design.md §4.2，编剧侧纸面）。
 * 卡在剧情流上的纸面便签胶囊：⚡ + 名称 + 情绪基调 + 常驻 ⚙️，无展开身体。
 */
export default function BeatNode({ data, selected }: NodeProps<BeatFlowNode>) {
  return (
    <div className={`pw-beat${selected ? ' pw-on' : ''}`}>
      <span aria-hidden>⚡</span>
      <span>{data.name}</span>
      <span className="pw-beat-tone">基调：{data.tone}</span>
      <button type="button" className="pw-gear pw-gear-light" aria-label="节奏卡设置">
        ⚙️
      </button>
      <Handle type="target" position={Position.Left} className="pw-port" />
      <Handle type="source" position={Position.Right} className="pw-port" />
    </div>
  )
}
