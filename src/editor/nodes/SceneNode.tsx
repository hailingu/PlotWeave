import { Position, type NodeProps } from '@xyflow/react'
import { useNodeEdit } from '../nodeEdit'
import { SCENE_SHOT_HANDLE } from '../graphRules'
import { NodeSettingsPanel, EditableName } from './settings/NodeSettingsPanel'
import { NodeSettingsGear } from './settings/NodeSettingsGear'
import { resolveCharacterAvatar, resolveLocationName } from '../settings'
import type { SceneFlowNode } from './types'
import { NodePort } from './NodePort'
import { NodeKind } from './NodeKind'

/**
 * 场景内容卡（docs/ui-design.md §4.2）：类型与编号、名称、地点摘要、
 * 梗概和在场角色共用中性表面，选中使用统一蓝色细框。
 * 端口：左 = 剧情流入口，右 = 剧情流出口，底部 = 分镜卡下挂口（垂直派生）。
 * 名称双击内联改名；⚙️ 打开设置面板（§4.3，编辑即命令）。
 */

/** 在场角色头像串；条目已删除回落 ✕ 占位（SceneNode 拆分，issue #99）。 */
function CharacterAvatarStrip({
  settings,
  characterIds,
}: {
  readonly settings: Parameters<typeof resolveCharacterAvatar>[0]
  readonly characterIds: readonly string[]
}) {
  return (
    <div className="pw-avs">
      {characterIds.map((cid) => {
        const avatar = resolveCharacterAvatar(settings, cid)
        return avatar ? (
          <span
            key={cid}
            className="pw-av"
            style={{ background: avatar.gradient }}
          >
            {avatar.label}
          </span>
        ) : (
          <span
            key={cid}
            className="pw-av pw-av-invalid"
            title="设定集条目已删除"
          >
            ✕
          </span>
        )
      })}
    </div>
  )
}

/** 场景索引卡（§4.3）：卡片头（场号 + 可改名标题）、设定摘要与底部
 * shots 端口（attach 下挂分镜卡，§4.4）；设置面板锚定展开。 */
export function SceneNode({ id, data, selected }: NodeProps<SceneFlowNode>) {
  const { openSettingsId, toggleSettings, patchNode, shotCountOf, settings } =
    useNodeEdit()
  const settingsOpen = openSettingsId === id

  return (
    <div className={`pw-card pw-index${selected ? ' pw-on' : ''}`}>
      <div className="pw-index-body">
        <NodeKind
          kind="scene"
          detail={`SCENE ${String(data.sceneNo).padStart(2, '0')}`}
        >
          <span className="pw-node-detail">{shotCountOf(id)} 镜</span>
          <NodeSettingsGear
            ariaLabel="场景设置"
            open={settingsOpen}
            onToggle={() => toggleSettings(id)}
          />
        </NodeKind>
        <div className="pw-index-tb pw-node-title">
          <EditableName
            value={data.name}
            ariaLabel="场景名称"
            onChange={(name) =>
              patchNode(id, { nodeType: 'scene', patch: { name } })
            }
          />
        </div>
        <SceneMetadata data={data} />
        <p className="pw-index-syn">{data.synopsis}</p>
        {data.characterIds.length > 0 && (
          <CharacterAvatarStrip
            settings={settings}
            characterIds={data.characterIds}
          />
        )}
      </div>
      {settingsOpen && <NodeSettingsPanel node={{ id, type: 'scene', data }} />}
      <NodePort
        nodeId={id}
        type="target"
        position={Position.Left}
        label="场景入口"
      />
      <NodePort
        nodeId={id}
        type="source"
        position={Position.Right}
        label="场景出口"
      />
      <NodePort
        nodeId={id}
        id={SCENE_SHOT_HANDLE}
        type="source"
        position={Position.Bottom}
        label="场景分镜出口"
      />
    </div>
  )
}

/** 场景摘要实时解析地点引用，删除地点仍显示可识别的失效状态。 */
function SceneMetadata({ data }: { readonly data: SceneFlowNode['data'] }) {
  const { settings } = useNodeEdit()
  const locationName = data.locationId
    ? resolveLocationName(settings, data.locationId)
    : null
  const invalidLocation = Boolean(data.locationId) && locationName === null
  return (
    <div className="pw-index-meta">
      <span className="pw-index-ie">{data.interior ? '内' : '外'}</span>
      <span className={invalidLocation ? 'pw-invalid' : undefined}>
        {invalidLocation ? '⚠ 未指定' : `📍 ${locationName ?? '未指定'}`}
      </span>
      <span className="pw-index-sep">·</span>
      <span>{data.time}</span>
      {data.weather && <span className="pw-index-wx">{data.weather}</span>}
    </div>
  )
}
