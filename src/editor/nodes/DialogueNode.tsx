import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useNodeEdit } from '../nodeEdit'
import { NodeSettingsPanel, EditableName } from './settings/NodeSettingsPanel'
import { NodeSettingsGear } from './settings/NodeSettingsGear'
import { resolveCharacterAvatar, resolveCharacterName } from '../settings'
import type { DialogueFlowNode } from './types'

/**
 * 对白节点 = 气泡流（docs/ui-design.md §4.2，剧本族纸面浅色，双外观恒定）。
 * 窄标题行承载名称与「n 人 · m 句」派生统计 + 常驻 ⚙️；
 * 台词渲染为角色头像 + 左右交替气泡，动作行居中斜体。
 * 名称双击内联改名；⚙️ 打开设置面板（§4.3，编辑即命令）。
 */

/** 角色头像；设定集条目已删除时回落 ✕ 占位（DialogueNode 拆分，issue #99）。 */
function SpeakerAvatar({
  settings,
  speaker,
}: {
  settings: Parameters<typeof resolveCharacterAvatar>[0]
  speaker: string
}) {
  const avatar = resolveCharacterAvatar(settings, speaker)
  return avatar ? (
    <span className="pw-av pw-av-sm" style={{ background: avatar.gradient }}>
      {avatar.label}
    </span>
  ) : (
    <span className="pw-av pw-av-sm pw-av-invalid" title="设定集条目已删除">
      ✕
    </span>
  )
}

/** 对白节点卡（§4.3）：台词计数徽标 + 可改名标题；说话人头像/名称经
 * 设定集实时解析（失效引用按 §4.3 标注）。 */
export function DialogueNode({
  id,
  data,
  selected,
}: NodeProps<DialogueFlowNode>) {
  const { openSettingsId, toggleSettings, patchNode, settings } = useNodeEdit()
  const settingsOpen = openSettingsId === id
  const speakers = new Set(
    data.lines.flatMap((l) =>
      l.kind === 'line' && l.speaker ? [l.speaker] : [],
    ),
  )
  const lineCount = data.lines.filter((l) => l.kind === 'line').length

  return (
    <div className={`pw-dlg${selected ? ' pw-on' : ''}`}>
      <div className="pw-dlg-head">
        <EditableName
          value={data.name}
          ariaLabel="对白名称"
          onChange={(name) =>
            patchNode(id, { nodeType: 'dialogue', patch: { name } })
          }
        />
        <span className="pw-dlg-stat">
          {speakers.size} 人 · {lineCount} 句
        </span>
        <span className="pw-sp" />
        <NodeSettingsGear
          ariaLabel="对白设置"
          open={settingsOpen}
          onToggle={() => toggleSettings(id)}
          light
        />
      </div>
      <div className="pw-dlg-body">
        {data.lines.map((line) =>
          line.kind === 'action' ? (
            <div key={line.id} className="pw-dlg-act">
              {line.text}
            </div>
          ) : (
            <div
              key={line.id}
              className={`pw-dlg-bubrow${line.side === 'right' ? ' pw-right' : ''}`}
            >
              {line.speaker && (
                <SpeakerAvatar settings={settings} speaker={line.speaker} />
              )}
              <span className="pw-dlg-bub">
                {line.speaker &&
                  !resolveCharacterName(settings, line.speaker) && (
                    <span className="pw-invalid">已删除角色：</span>
                  )}
                {line.text}
                {line.vo && <span className="pw-dlg-vo">VO</span>}
              </span>
            </div>
          ),
        )}
      </div>
      {settingsOpen && (
        <NodeSettingsPanel node={{ id, type: 'dialogue', data }} />
      )}
      <Handle type="target" position={Position.Left} className="pw-port" />
      <Handle type="source" position={Position.Right} className="pw-port" />
    </div>
  )
}
