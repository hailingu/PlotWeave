import { useNodeEdit } from '../nodeEdit'
import { resolveLocationName } from '../settings'
import type { SceneFlowNode } from './types'
import { NodeGlyph, type NodeGlyphName } from './NodeGlyph'
import { sceneAttribute } from './sceneAttribute'

/** 中性摘要标签提供完整名称；装饰符号不重复进入辅助技术读音。 */
function MetadataTag({
  kind,
  label,
  icon,
  invalid = false,
}: {
  readonly kind: string
  readonly label: string
  readonly icon: NodeGlyphName
  readonly invalid?: boolean
}) {
  return (
    <fieldset
      className={`pw-index-chip${invalid ? ' pw-invalid' : ''}`}
      aria-label={`${kind}：${label}`}
      title={invalid ? '地点引用已失效' : label}
    >
      <NodeGlyph name={icon} />
      <span className="pw-index-chip-label">{label}</span>
    </fieldset>
  )
}

/** 场景摘要实时解析地点并兼容历史时间／天气装饰，不修改保存数据。 */
export function SceneMetadata({
  data,
}: {
  readonly data: SceneFlowNode['data']
}) {
  const { settings } = useNodeEdit()
  const locationName = data.locationId
    ? resolveLocationName(settings, data.locationId)
    : null
  const invalidLocation = Boolean(data.locationId) && locationName === null
  const time = sceneAttribute('time', data.time)
  const weather = sceneAttribute('weather', data.weather ?? '')
  return (
    <div className="pw-index-meta">
      <span className="pw-index-ie">{data.interior ? '内' : '外'}</span>
      <MetadataTag
        kind="地点"
        label={locationName ?? '未指定'}
        icon={invalidLocation ? 'warning' : 'pin'}
        invalid={invalidLocation}
      />
      {time && <MetadataTag kind="时间" {...time} />}
      {weather && <MetadataTag kind="天气" {...weather} />}
    </div>
  )
}
