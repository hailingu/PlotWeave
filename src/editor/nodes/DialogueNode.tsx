import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { DialogueFlowNode } from './types'

/**
 * 对白节点 = 气泡流（docs/ui-design.md §4.2，剧本族纸面浅色，双外观恒定）。
 * 窄标题行承载名称与「n 人 · m 句」派生统计 + 常驻 ⚙️；
 * 台词渲染为角色头像 + 左右交替气泡，动作行居中斜体。
 */
export default function DialogueNode({ data, selected }: NodeProps<DialogueFlowNode>) {
  const speakers = new Set(
    data.lines.filter((l) => l.kind === 'line' && l.speaker).map((l) => l.speaker!.label),
  )
  const lineCount = data.lines.filter((l) => l.kind === 'line').length

  return (
    <div className={`pw-dlg${selected ? ' pw-on' : ''}`}>
      <div className="pw-dlg-head">
        <span>{data.name}</span>
        <span className="pw-dlg-stat">
          {speakers.size} 人 · {lineCount} 句
        </span>
        <span className="pw-sp" />
        <button type="button" className="pw-gear pw-gear-light" aria-label="对白设置">
          ⚙️
        </button>
      </div>
      <div className="pw-dlg-body">
        {data.lines.map((line, i) =>
          line.kind === 'action' ? (
            <div key={i} className="pw-dlg-act">
              {line.text}
            </div>
          ) : (
            <div
              key={i}
              className={`pw-dlg-bubrow${line.side === 'right' ? ' pw-right' : ''}`}
            >
              {line.speaker && (
                <span
                  className="pw-av pw-av-sm"
                  style={{ background: line.speaker.gradient }}
                >
                  {line.speaker.label}
                </span>
              )}
              <span className="pw-dlg-bub">
                {line.text}
                {line.vo && <span className="pw-dlg-vo">VO</span>}
              </span>
            </div>
          ),
        )}
      </div>
      <Handle type="target" position={Position.Left} className="pw-port" />
      <Handle type="source" position={Position.Right} className="pw-port" />
    </div>
  )
}
