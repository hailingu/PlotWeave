import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useNodeEdit } from '../nodeEdit'
import NodeSettingsPanel from './settings/NodeSettingsPanel'
import type { ShotFlowNode } from './types'

/** 引用位 chip 的图标：角色垫图 / 场景底图 / 音频。 */
const REF_ICONS = { character: '👤', location: '🏞', audio: '🎵' } as const

/**
 * 分镜卡 = 监视器卡（docs/ui-design.md §4.2，生成侧深色石板，双外观恒定）。
 * 一张卡 = 一个镜头及其 AI 燃料：镜号 + 景别标题行（常驻 ⚙️）、
 * 画面描述、镜头 Prompt、垫图/底图/音频引用位。
 * 从属关系走顶部入口：宿主索引卡底部端口垂直下挂（§4.4 attach 边）。
 * ⚙️ 打开设置面板（§4.3，编辑即命令）；镜号标题行不设内联改名。
 */
export default function ShotNode({ id, data, selected }: NodeProps<ShotFlowNode>) {
  const { openSettingsId, toggleSettings, settings } = useNodeEdit()
  const settingsOpen = openSettingsId === id

  /** 引用位显示名（§8.1）：targetId 按设定集实时解析；
   * 解析不到（失效引用）回退 label，再回退原始 id 供辨认。 */
  const refText = (ref: ShotFlowNode['data']['refs'][number]): string => {
    if (ref.kind === 'character') {
      return settings.characters.find((c) => c.id === ref.targetId)?.name ?? ref.label ?? ref.targetId ?? ''
    }
    if (ref.kind === 'location') {
      return settings.locations.find((l) => l.id === ref.targetId)?.name ?? ref.label ?? ref.targetId ?? ''
    }
    return ref.label ?? ref.targetId ?? ''
  }

  return (
    <div className={`pw-shot${selected ? ' pw-on' : ''}`}>
      <div className="pw-shot-tb">
        <span className="pw-shot-no">SHOT {String(data.shotNo).padStart(2, '0')}</span>
        <span className="pw-shot-size">{data.size}</span>
        <span className="pw-sp" />
        <button
          type="button"
          className={`pw-gear nodrag${settingsOpen ? ' pw-gear-open' : ''}`}
          data-pw-gear
          aria-label="分镜设置"
          aria-expanded={settingsOpen}
          onClick={(e) => {
            e.stopPropagation()
            toggleSettings(id)
          }}
        >
          ⚙️
        </button>
      </div>
      <p className="pw-shot-picture">{data.picture}</p>
      <div className="pw-shot-prompt">
        <span className="pw-shot-prompt-label">镜头 PROMPT</span>
        {data.prompt}
      </div>
      <div className="pw-shot-refs">
        {data.refs.map((ref) => (
          <span key={ref.id} className="pw-shot-ref">
            {REF_ICONS[ref.kind]} {refText(ref)}
          </span>
        ))}
        <span className="pw-shot-ref pw-shot-ref-add" aria-hidden>
          ＋ 引用
        </span>
      </div>
      {settingsOpen && <NodeSettingsPanel node={{ id, type: 'shot', data }} />}
      <Handle type="target" position={Position.Top} className="pw-port" />
      <Handle type="source" position={Position.Right} className="pw-port" />
    </div>
  )
}
