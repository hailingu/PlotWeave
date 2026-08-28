import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useNodeEdit } from '../nodeEdit'
import NodeSettingsPanel, { EditableName } from './settings/NodeSettingsPanel'
import type { BeatFlowNode } from './types'

/**
 * 节奏卡 = 节拍胶囊（docs/ui-design.md §4.2，编剧侧纸面）。
 * 卡在剧情流上的纸面便签胶囊：⚡ + 名称 + 情绪基调 + 常驻 ⚙️，无展开身体。
 * 兑现状态（§3.5）：未被场景承载 = 待兑现虚线态；兑现后 ✓ 徽标（派生，不落字段）。
 * 名称双击内联改名；⚙️ 打开设置面板（§4.3，编辑即命令）。
 */
export default function BeatNode({ id, data, selected }: NodeProps<BeatFlowNode>) {
  const { openSettingsId, toggleSettings, patchNode, beatFulfillmentOf } = useNodeEdit()
  const settingsOpen = openSettingsId === id
  const fulfillment = beatFulfillmentOf(id)
  const pending = fulfillment?.status === 'pending'

  return (
    <div className={`pw-beat${selected ? ' pw-on' : ''}${pending ? ' pw-beat-pending' : ''}`}>
      <span aria-hidden>⚡</span>
      <EditableName
        value={data.name}
        ariaLabel="节奏卡内容"
        onChange={(name) => patchNode(id, { name })}
      />
      <span className="pw-beat-tone">基调：{data.tone}</span>
      {pending ? (
        <span className="pw-beat-state pending" title="未被场景承载的节拍 = 节奏漏洞">
          待兑现
        </span>
      ) : (
        fulfillment?.status === 'fulfilled' && (
          <span className="pw-beat-state ok" title={`兑现于 ${fulfillment.sceneLabel ?? ''}`}>
            ✓
          </span>
        )
      )}
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
