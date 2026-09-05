import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useNodeEdit } from '../nodeEdit'
import { SCENE_SHOT_HANDLE } from '../graphRules'
import NodeSettingsPanel, { EditableName } from './settings/NodeSettingsPanel'
import {
  resolveCharacterAvatar,
  resolveLocationName,
} from '../settings'
import type { SceneFlowNode } from './types'

// 常量权威定义在 graphRules（连线规则纯函数），此处按原导出名转出
export { SCENE_SHOT_HANDLE }

/**
 * 场景节点 = 索引卡（docs/ui-design.md §4.2，编剧侧纸面）。
 * 经典编剧索引卡形态：暖白纸面 + 满页蓝色横格线 + 左侧红色竖边距线；
 * 分区为名称 + SCENE 编号 + 🎞 镜数 + ⚙️ 的标题栏、地点/时间 chip 行、
 * 梗概（压在横格线上）、在场角色头像串。选中为通用品牌渐变描边。
 * 端口：左 = 剧情流入口，右 = 剧情流出口，底部 = 分镜卡下挂口（垂直派生）。
 * 名称双击内联改名；⚙️ 打开设置面板（§4.3，编辑即命令）。
 */
export default function SceneNode({ id, data, selected }: NodeProps<SceneFlowNode>) {
  const { openSettingsId, toggleSettings, patchNode, shotCountOf, settings } = useNodeEdit()
  const settingsOpen = openSettingsId === id
  const locationName = data.locationId
    ? resolveLocationName(settings, data.locationId)
    : null
  const invalidLocation = Boolean(data.locationId) && locationName === null

  return (
    <div className={`pw-index${selected ? ' pw-on' : ''}`}>
      <div className="pw-index-body">
        <div className="pw-index-tb">
          <EditableName
            value={data.name}
            ariaLabel="场景名称"
            onChange={(name) => patchNode(id, { nodeType: 'scene', patch: { name } })}
          />
          <span className="pw-index-no">
            SCENE {String(data.sceneNo).padStart(2, '0')}
          </span>
          <span className="pw-sp" />
          <span className="pw-index-shots">🎞 {shotCountOf(id)} 镜</span>
          <button
            type="button"
            className={`pw-gear pw-gear-light nodrag${settingsOpen ? ' pw-gear-open' : ''}`}
            data-pw-gear
            aria-label="场景设置"
            aria-expanded={settingsOpen}
            onClick={(e) => {
              e.stopPropagation()
              toggleSettings(id)
            }}
          >
            ⚙️
          </button>
        </div>
        <div className="pw-index-meta">
          <span className="pw-index-ie">{data.interior ? '内' : '外'}</span>
          <span className={invalidLocation ? 'pw-invalid' : undefined}>
            {invalidLocation ? '⚠ 未指定' : `📍 ${locationName ?? '📍 未指定'}`}
          </span>
          <span className="pw-index-sep">·</span>
          <span>{data.time}</span>
          {data.weather && <span className="pw-index-wx">{data.weather}</span>}
        </div>
        <p className="pw-index-syn">{data.synopsis}</p>
        {data.characterIds.length > 0 && (
          <div className="pw-avs">
            {data.characterIds.map((cid) => {
              const avatar = resolveCharacterAvatar(settings, cid)
              return avatar ? (
                <span key={cid} className="pw-av" style={{ background: avatar.gradient }}>
                  {avatar.label}
                </span>
              ) : (
                <span key={cid} className="pw-av pw-av-invalid" title="设定集条目已删除">
                  ✕
                </span>
              )
            })}
          </div>
        )}
      </div>
      {settingsOpen && <NodeSettingsPanel node={{ id, type: 'scene', data }} />}
      <Handle type="target" position={Position.Left} className="pw-port" />
      <Handle type="source" position={Position.Right} className="pw-port" />
      <Handle
        id={SCENE_SHOT_HANDLE}
        type="source"
        position={Position.Bottom}
        className="pw-port pw-port-down"
      />
    </div>
  )
}
