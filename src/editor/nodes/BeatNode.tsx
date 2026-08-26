import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useNodeEdit } from '../nodeEdit'
import NodeSettingsPanel, { EditableName } from './settings/NodeSettingsPanel'
import type { BeatFlowNode } from './types'

/**
 * 节奏卡 = 节拍胶囊（docs/ui-design.md §4.2，编剧侧纸面）。
 * 卡在剧情流上的纸面便签胶囊：⚡ + 名称 + 情绪基调 + 常驻 ⚙️，无展开身体。
 * 名称双击内联改名；⚙️ 打开设置面板（§4.3，编辑即命令）。
 */
export default function BeatNode({ id, data, selected }: NodeProps<BeatFlowNode>) {
  const { openSettingsId, toggleSettings, patchNode } = useNodeEdit()
  const settingsOpen = openSettingsId === id

  return (
    <div className={`pw-beat${selected ? ' pw-on' : ''}`}>
      <span aria-hidden>⚡</span>
      <EditableName
        value={data.name}
        ariaLabel="节奏卡内容"
        onChange={(name) => patchNode(id, { name })}
      />
      <span className="pw-beat-tone">基调：{data.tone}</span>
      <button
        type="button"
        className={`pw-gear pw-gear-light nodrag${settingsOpen ? ' pw-gear-open' : ''}`}
        data-pw-gear
        aria-label="节奏卡设置"
        aria-expanded={settingsOpen}
        onClick={(e) => {
          e.stopPropagation()
          toggleSettings(id)
        }}
      >
        ⚙️
      </button>
      {settingsOpen && <NodeSettingsPanel node={{ id, type: 'beat', data }} />}
      <Handle type="target" position={Position.Left} className="pw-port" />
      <Handle type="source" position={Position.Right} className="pw-port" />
    </div>
  )
}
