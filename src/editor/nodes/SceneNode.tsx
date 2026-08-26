import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useNodeEdit } from '../nodeEdit'
import NodeSettingsPanel, { EditableName } from './settings/NodeSettingsPanel'
import type { SceneFlowNode } from './types'

/** 索引卡底部下挂分镜卡的专属源端口 id（§4.4：横向 = 剧情顺序，垂直 = 派生从属）。 */
export const SCENE_SHOT_HANDLE = 'shots'

/**
 * 场景节点 = 索引卡（docs/ui-design.md §4.2，编剧侧纸面）。
 * 经典编剧索引卡形态：暖白纸面 + 满页蓝色横格线 + 左侧红色竖边距线；
 * 分区为名称 + SCENE 编号 + 🎞 镜数 + ⚙️ 的标题栏、地点/时间 chip 行、
 * 梗概（压在横格线上）、在场角色头像串。选中为通用品牌渐变描边。
 * 端口：左 = 剧情流入口，右 = 剧情流出口，底部 = 分镜卡下挂口（垂直派生）。
 * 名称双击内联改名；⚙️ 打开设置面板（§4.3，编辑即命令）。
 */
export default function SceneNode({ id, data, selected }: NodeProps<SceneFlowNode>) {
  const { openSettingsId, toggleSettings, patchNode, shotCountOf } = useNodeEdit()
  const settingsOpen = openSettingsId === id

  return (
    <div className={`pw-index${selected ? ' pw-on' : ''}`}>
      <div className="pw-index-body">
        <div className="pw-index-tb">
          <EditableName
            value={data.name}
            ariaLabel="场景名称"
            onChange={(name) => patchNode(id, { name })}
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
          <span>📍 {data.location}</span>
          <span className="pw-index-sep">·</span>
          <span>{data.time}</span>
          {data.weather && <span className="pw-index-wx">{data.weather}</span>}
        </div>
        <p className="pw-index-syn">{data.synopsis}</p>
        {data.characters.length > 0 && (
          <div className="pw-avs">
            {data.characters.map((c) => (
              <span
                key={c.label}
                className="pw-av"
                style={{ background: c.gradient }}
              >
                {c.label}
              </span>
            ))}
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
