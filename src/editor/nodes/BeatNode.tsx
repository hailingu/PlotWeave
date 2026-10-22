import { Position, type NodeProps } from '@xyflow/react'
import { useNodeEdit } from '../nodeEdit'
import { NodeSettingsPanel, EditableName } from './settings/NodeSettingsPanel'
import { NodeSettingsGear } from './settings/NodeSettingsGear'
import type { BeatFlowNode } from './types'
import { NodePort } from './NodePort'
import { NodeKind } from './NodeKind'
import type { BeatFulfillment } from '../outline'

/**
 * 节奏卡 = 紧凑内容卡（docs/ui-design.md §4.2）：类型、名称与情绪基调。
 * 兑现状态（§3.5）：未被场景承载 = 待兑现虚线态；兑现后 ✓ 徽标（派生，不落字段）。
 * 名称双击内联改名；⚙️ 打开设置面板（§4.3，编辑即命令）。
 */
export function BeatNode({ id, data, selected }: NodeProps<BeatFlowNode>) {
  const { openSettingsId, toggleSettings, patchNode, beatFulfillmentOf } =
    useNodeEdit()
  const settingsOpen = openSettingsId === id
  const fulfillment = beatFulfillmentOf(id)
  const pending = fulfillment?.status === 'pending'

  return (
    <div
      className={`pw-card pw-beat${selected ? ' pw-on' : ''}${pending ? ' pw-beat-pending' : ''}`}
    >
      <NodeKind kind="beat">
        <NodeSettingsGear
          ariaLabel="节奏卡设置"
          open={settingsOpen}
          onToggle={() => toggleSettings(id)}
        />
      </NodeKind>
      <div className="pw-node-title">
        <EditableName
          value={data.name}
          ariaLabel="节奏卡内容"
          onChange={(name) =>
            patchNode(id, { nodeType: 'beat', patch: { name } })
          }
        />
      </div>
      <div className="pw-beat-body">
        <span className="pw-beat-tone">基调：{data.tone}</span>
        <BeatState fulfillment={fulfillment} />
      </div>
      {settingsOpen && <NodeSettingsPanel node={{ id, type: 'beat', data }} />}
      <NodePort
        nodeId={id}
        type="target"
        position={Position.Left}
        label="节奏卡入口"
      />
      <NodePort
        nodeId={id}
        type="source"
        position={Position.Right}
        label="节奏卡出口"
      />
    </div>
  )
}

/** 节拍兑现徽标保留待兑现说明与兑现目标，无独立持久化状态。 */
function BeatState({
  fulfillment,
}: {
  readonly fulfillment: BeatFulfillment | null
}) {
  if (fulfillment?.status === 'pending')
    return (
      <span
        className="pw-beat-state pending"
        title="未被场景承载的节拍 = 节奏漏洞"
      >
        待兑现
      </span>
    )
  if (fulfillment?.status === 'fulfilled')
    return (
      <span
        className="pw-beat-state ok"
        title={`兑现于 ${fulfillment.sceneLabel ?? ''}`}
      >
        ✓
      </span>
    )
  return null
}
