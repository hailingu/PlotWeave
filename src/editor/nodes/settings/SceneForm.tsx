import Field from './Field'
import EpisodeField from './EpisodeField'
import { useCompositionSafeValue } from './compositionValue'
import { useNodeEdit } from '../../nodeEdit'
import type { ProjectSettings } from '../../settings'
import type { SceneNodeData } from '../types'
import type { PatchShape } from '../patch'
import type { PanelNode } from './NodeSettingsPanel'

/** 内外景分段（§4.2 索引卡徽标）：SceneForm 拆出的同族分区。 */
function SceneInteriorSegment({
  interior,
  onPick,
}: {
  readonly interior: boolean
  readonly onPick: (value: boolean) => void
}) {
  return (
    <Field label="内外景">
      <div className="pw-set-seg">
        <button type="button" className={interior ? 'on' : ''} onClick={() => onPick(true)}>
          内
        </button>
        <button type="button" className={!interior ? 'on' : ''} onClick={() => onPick(false)}>
          外
        </button>
      </div>
    </Field>
  )
}

/** 出场角色 chips（§4.2 引用设定集实体 id；§4.3 失效引用展示）：SceneForm 拆出的分区。 */
function SceneCastChips({
  characterIds,
  characters,
  onToggle,
}: {
  readonly characterIds: string[]
  readonly characters: ProjectSettings['characters']
  readonly onToggle: (id: string) => void
}) {
  return (
    <Field label="出场角色">
      <div className="pw-set-chips">
        {characters.map((c) => {
          const on = characterIds.includes(c.id)
          return (
            <button
              key={c.id}
              type="button"
              className={`pw-set-chip${on ? ' on' : ''}`}
              onClick={() => onToggle(c.id)}
              aria-pressed={on}
            >
              <span className="pw-av pw-av-sm" style={{ background: c.gradient }}>
                {c.name.charAt(0)}
              </span>
              {c.name}
            </button>
          )
        })}
        {characters.length === 0 && (
          <span className="pw-set-empty">设定集暂无角色，请在左栏新增</span>
        )}
      </div>
    </Field>
  )
}

/** 场景表单：名称/地点/时间/天气/内外景/梗概/出场角色（设定集引用切换）。
 * patch 回调在表单内收口 nodeType 判别字段，字段更新保持单行表达；
 * 自由文本字段经 useCompositionSafeValue 缓冲中文组合输入（issue #42）。
 * 自 NodeSettingsPanel.tsx 外置（issue #39，ImageNodeForm.tsx 先例）。 */
export default function SceneForm({ node, settings }: { readonly node: Extract<PanelNode, { type: 'scene' }>; readonly settings: ProjectSettings }) {
  const { patchNode } = useNodeEdit()
  const d = node.data
  // PatchShape 已剥离索引签名（issue 16）：本地回调与判别命令同严——
  // 宽键（如 scene 表单混入对白的 lines）在此即编译失败
  const patch = (p: PatchShape<SceneNodeData>) => patchNode(node.id, { nodeType: 'scene', patch: p })
  const name = useCompositionSafeValue(d.name, (next) => patch({ name: next }))
  const time = useCompositionSafeValue(d.time, (next) => patch({ time: next }))
  const weather = useCompositionSafeValue(d.weather ?? '', (next) => patch({ weather: next }))
  const synopsis = useCompositionSafeValue(d.synopsis, (next) => patch({ synopsis: next }))
  const toggleCharacter = (id: string) => {
    const on = d.characterIds.includes(id)
    patch({
      characterIds: on ? d.characterIds.filter((cid) => cid !== id) : [...d.characterIds, id],
    })
  }
  return (
    <>
      <Field label="名称">
        <input className="pw-set-input" {...name} />
      </Field>
      <Field label="场次">
        <input
          className="pw-set-input"
          type="number"
          min={1}
          value={d.sceneNo}
          aria-label="场次"
          onChange={(e) => {
            // 场次必填（导出/卡片头消费）：清空/非法输入不产生 patch，
            // 保留原值等用户输入完成
            const raw = e.target.value
            if (raw === '') return
            const n = Math.max(1, Math.floor(Number(raw)))
            // §4.1 正安全整数域：有限但越界（如 1e20）落载后会被顺位重发，同域拒收
            if (Number.isSafeInteger(n) && n !== d.sceneNo) patch({ sceneNo: n })
          }}
        />
      </Field>
      <div className="pw-set-cols">
        <Field label="地点">
          <select
            className="pw-set-input"
            value={d.locationId ?? ''}
            onChange={(e) => patch({ locationId: e.target.value || undefined })}
          >
            <option value="">未指定</option>
            {settings.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="时间">
          <input className="pw-set-input" {...time} />
        </Field>
      </div>
      <Field label="天气">
        <input className="pw-set-input" placeholder="可选" {...weather} />
      </Field>
      <SceneInteriorSegment interior={d.interior} onPick={(value) => patch({ interior: value })} />
      <Field label="梗概">
        <textarea className="pw-set-input" rows={3} {...synopsis} />
      </Field>
      <SceneCastChips characterIds={d.characterIds} characters={settings.characters} onToggle={toggleCharacter} />
      <EpisodeField nodeType="scene" nodeId={node.id} episodeNo={d.episodeNo} />
    </>
  )
}
