import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { BranchFlowNode } from './types'

/** 分支选项出口端口的 handle id 前缀（对应数据模型 option-n）。 */
export const BRANCH_OPTION_HANDLE_PREFIX = 'option-'

/**
 * 分支节点 = 岔路路标（docs/ui-design.md §4.2，剧本族）。
 * 虚线外框 = 「此处未定」；问句即名称；每个选项条右缘带独立出口端口
 * （handle id 为 option-n，供 branch 边连线），「＋ 添加选项」行内完成（本阶段仅展示结构）。
 * 外观跟随画布：浅色画布为纸面变体，深色画布为虚线暗框。
 */
export default function BranchNode({ data, selected }: NodeProps<BranchFlowNode>) {
  return (
    <div className={`pw-branch${selected ? ' pw-on' : ''}`}>
      <div className="pw-branch-q">
        <span aria-hidden>🔀</span>
        <span>{data.prompt}</span>
        <span className="pw-sp" />
        <button type="button" className="pw-gear pw-gear-light" aria-label="分支设置">
          ⚙️
        </button>
      </div>
      {data.options.map((option, i) => (
        <div key={i} className="pw-branch-opt">
          {option}
          <Handle
            id={`${BRANCH_OPTION_HANDLE_PREFIX}${i}`}
            type="source"
            position={Position.Right}
            className="pw-port pw-branch-port"
          />
        </div>
      ))}
      <div className="pw-branch-addopt" aria-hidden>
        ＋ 添加选项
      </div>
      <Handle type="target" position={Position.Left} className="pw-port" />
    </div>
  )
}
