import { Position, type NodeProps } from '@xyflow/react'
import { useNodeEdit } from '../nodeEdit'
import { NodeSettingsPanel, EditableName } from './settings/NodeSettingsPanel'
import { NodeSettingsGear } from './settings/NodeSettingsGear'
import { resolveCharacterAvatar, resolveCharacterName } from '../settings'
import type { DialogueFlowNode } from './types'
import { NodePort } from './NodePort'
import { NodeKind } from './NodeKind'

/**
 * 对白内容卡 = 中性表面的气泡流（docs/ui-design.md §4.2）。
 * 窄标题行承载名称与「n 人 · m 句」派生统计 + 常驻 ⚙️；
 * 台词渲染为角色头像 + 左右交替气泡，动作行居中使用次级文字。
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
  const { openSettingsId, toggleSettings, patchNode } = useNodeEdit()
  const settingsOpen = openSettingsId === id
  const speakers = new Set(
    data.lines.flatMap((l) =>
      l.kind === 'line' && l.speaker ? [l.speaker] : [],
    ),
  )
  const lineCount = data.lines.filter((l) => l.kind === 'line').length

  return (
    <div className={`pw-card pw-dlg${selected ? ' pw-on' : ''}`}>
      <div className="pw-dlg-head">
        <NodeKind
          kind="dialogue"
          detail={`${speakers.size} 人 · ${lineCount} 句`}
        >
          <NodeSettingsGear
            ariaLabel="对白设置"
            open={settingsOpen}
            onToggle={() => toggleSettings(id)}
          />
        </NodeKind>
        <div className="pw-node-title">
          <EditableName
            value={data.name}
            ariaLabel="对白名称"
            onChange={(name) =>
              patchNode(id, { nodeType: 'dialogue', patch: { name } })
            }
          />
        </div>
      </div>
      <DialogueBody lines={data.lines} />
      {settingsOpen && (
        <NodeSettingsPanel node={{ id, type: 'dialogue', data }} />
      )}
      <NodePort
        nodeId={id}
        type="target"
        position={Position.Left}
        label="对白入口"
      />
      <NodePort
        nodeId={id}
        type="source"
        position={Position.Right}
        label="对白出口"
      />
    </div>
  )
}

/** 台词内容独立于外壳；角色实时解析与失效标记仍使用同一设定集。 */
function DialogueBody({
  lines,
}: {
  readonly lines: DialogueFlowNode['data']['lines']
}) {
  const { settings } = useNodeEdit()
  return (
    <div className="pw-dlg-body">
      {lines.map((line) =>
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
  )
}
