import { Position, useStore, type NodeProps } from '@xyflow/react'
import { useNodeEdit } from '../nodeEdit'
import { branchOptionHandle } from '../graphRules'
import { NodeSettingsPanel, EditableName } from './settings/NodeSettingsPanel'
import { NodeSettingsGear } from './settings/NodeSettingsGear'
import type { BranchFlowNode, BranchOption } from './types'
import { NodePort } from './NodePort'
import { usePortActive } from './usePortActive'
import { NodeKind } from './NodeKind'

/**
 * 中性分支内容卡：问句可内联改名，每行外侧一个稳定选项出口。
 * 目标名称与选择态直接订阅当前画布，不新增存储字段。
 */
export function BranchNode({ id, data, selected }: NodeProps<BranchFlowNode>) {
  const { openSettingsId, toggleSettings, patchNode } = useNodeEdit()
  const settingsOpen = openSettingsId === id

  return (
    <div className={`pw-card pw-branch${selected ? ' pw-on' : ''}`}>
      <NodeKind kind="branch" detail={`${data.options.length} 个出口`}>
        <NodeSettingsGear
          ariaLabel="分支设置"
          open={settingsOpen}
          onToggle={() => toggleSettings(id)}
        />
      </NodeKind>
      <div className="pw-branch-q pw-node-title">
        <EditableName
          value={data.prompt}
          ariaLabel="分支问句"
          onChange={(prompt) =>
            patchNode(id, { nodeType: 'branch', patch: { prompt } })
          }
        />
      </div>
      {data.options.map((option) => (
        <BranchOptionRow key={option.id} nodeId={id} option={option} />
      ))}
      {settingsOpen && (
        <NodeSettingsPanel node={{ id, type: 'branch', data }} />
      )}
      <NodePort
        nodeId={id}
        type="target"
        position={Position.Left}
        label="分支入口"
      />
    </div>
  )
}

/** 分支行：多目标名称由稳定句柄的当前边派生，选中仅强调所连条目。 */
function BranchOptionRow({
  nodeId,
  option,
}: {
  readonly nodeId: string
  readonly option: BranchOption
}) {
  const handleId = branchOptionHandle(option.id)
  const active = usePortActive(nodeId, 'source', handleId)
  const targets = useStore((state) =>
    state.edges
      .filter(
        (edge) => edge.source === nodeId && edge.sourceHandle === handleId,
      )
      .map((edge) => {
        const data = state.nodeLookup.get(edge.target)?.data
        const name = data?.name ?? data?.prompt
        return typeof name === 'string' ? name : ''
      })
      .filter(Boolean)
      .join('、'),
  )
  return (
    <div className={`pw-branch-opt${active ? ' pw-branch-opt-active' : ''}`}>
      <span className="pw-branch-opt-label">{option.label}</span>
      {targets && (
        <span className="pw-branch-target" title={targets}>
          {targets}
        </span>
      )}
      <NodePort
        nodeId={nodeId}
        id={handleId}
        type="source"
        position={Position.Right}
        className="pw-branch-port"
        label={`分支出口：${option.label}`}
      />
    </div>
  )
}
