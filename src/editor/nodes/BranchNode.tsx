import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useNodeEdit } from '../nodeEdit'
import { BRANCH_OPTION_HANDLE_PREFIX } from '../graphRules'
import NodeSettingsPanel, { EditableName } from './settings/NodeSettingsPanel'
import type { BranchFlowNode } from './types'

// 常量权威定义在 graphRules（连线规则纯函数），此处按原导出名转出
export { BRANCH_OPTION_HANDLE_PREFIX }

/**
 * 分支节点 = 岔路路标（docs/ui-design.md §4.2，剧本族）。
 * 虚线外框 = 「此处未定」；问句即名称（双击内联编辑）；每个选项条右缘带
 * 独立出口端口（handle id 为 option-n，供 branch 边连线）；
 * 「＋ 添加选项」由 ⚙️ 设置面板承载（§4.3）。外观跟随画布：
 * 浅色画布为纸面变体，深色画布为虚线暗框。
 */
export default function BranchNode({ id, data, selected }: NodeProps<BranchFlowNode>) {
  const { openSettingsId, toggleSettings, patchNode } = useNodeEdit()
  const settingsOpen = openSettingsId === id

  return (
    <div className={`pw-branch${selected ? ' pw-on' : ''}`}>
      <div className="pw-branch-q">
        <span aria-hidden>🔀</span>
        <EditableName
          value={data.prompt}
          ariaLabel="分支问句"
          onChange={(prompt) => patchNode(id, { prompt })}
        />
        <span className="pw-sp" />
        <button
          type="button"
          className={`pw-gear pw-gear-light nodrag${settingsOpen ? ' pw-gear-open' : ''}`}
          data-pw-gear
          aria-label="分支设置"
          aria-expanded={settingsOpen}
          onClick={(e) => {
            e.stopPropagation()
            toggleSettings(id)
          }}
        >
          ⚙️
        </button>
      </div>
      {data.options.map((option, i) => (
        <div key={option.id} className="pw-branch-opt">
          {option.label}
          <Handle
            id={`${BRANCH_OPTION_HANDLE_PREFIX}${i}`}
            type="source"
            position={Position.Right}
            className="pw-port pw-branch-port"
          />
        </div>
      ))}
      {settingsOpen && <NodeSettingsPanel node={{ id, type: 'branch', data }} />}
      <Handle type="target" position={Position.Left} className="pw-port" />
    </div>
  )
}
