import { useState } from 'react'
import Field from './Field'
import ImageNodeForm from './ImageNodeForm'
import { useNodeEdit } from '../../nodeEdit'
import type { ProjectSettings } from '../../settings'
import { uid } from '../../../uid'
import { shotRefMimeMatches } from '../../../model/convert'
import type { ProjectContent } from '../../../model/content'
import type {
  BeatNodeData,
  BranchNodeData,
  DialogueLine,
  DialogueNodeData,
  ImageNodeData,
  SceneNodeData,
  ShotNodeData,
  ShotRef,
} from '../types'
import type { PatchShape } from '../patch'

/**
 * ⚙️ 设置面板 = 节点编辑器（docs/ui-design.md §4.3）。
 * 以卡片为锚在下方弹簧展开（半透明 blur），承载该节点类型的全部字段；
 * 编辑即命令——每次修改实时 patch 节点 data，无「保存」按钮；
 * 底部为 ⧉ 复制与 🗑 删除（danger 色）。失焦（外部点击）收起。
 * 根节点带 nodrag/nowheel：面板内的输入与滚动不触发画布拖拽缩放。
 */

/** 面板入参：id + 类型 + 该类型 data 的判别联合（NodeProps 不含完整 node）。 */
export type PanelNode =
  | { id: string; type: 'scene'; data: SceneNodeData }
  | { id: string; type: 'beat'; data: BeatNodeData }
  | { id: string; type: 'dialogue'; data: DialogueNodeData }
  | { id: string; type: 'branch'; data: BranchNodeData }
  | { id: string; type: 'shot'; data: ShotNodeData }
  | { id: string; type: 'image'; data: ImageNodeData }

/** 集归属（§3.5：集 = 编号 + 行内标题，节点以 episodeNo 归属集）。
 * 清空 = 移出所有集；分镜卡随宿主场景（attach 派生），不出此字段。 */
function EpisodeField({
  nodeType,
  nodeId,
  episodeNo,
}: {
  readonly nodeType: 'scene' | 'beat' | 'dialogue' | 'branch'
  readonly nodeId: string
  readonly episodeNo?: number
}) {
  const { patchNode } = useNodeEdit()
  return (
    <Field label="集">
      <div className="pw-set-ep">
        <input
          className="pw-set-input"
          type="number"
          min={1}
          value={episodeNo ?? ''}
          placeholder="未分集"
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '') {
              patchNode(nodeId, { nodeType, patch: { episodeNo: undefined } })
              return
            }
            const n = Math.max(1, Math.floor(Number(raw)))
            // §4.1 正安全整数域：有限但越界（如 1e20）落载后会被顺位重发，
            // 输入边界同域拒收——不 patch，保留原值等用户输入完成
            if (Number.isSafeInteger(n)) patchNode(nodeId, { nodeType, patch: { episodeNo: n } })
          }}
        />
        {episodeNo !== undefined && (
          <button
            type="button"
            className="pw-set-x"
            aria-label="移出集"
            title="移出集（未分集）"
            onClick={() => patchNode(nodeId, { nodeType, patch: { episodeNo: undefined } })}
          >
            ✕
          </button>
        )}
      </div>
    </Field>
  )
}

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
 * patch 回调在表单内收口 nodeType 判别字段，字段更新保持单行表达。 */
function SceneForm({ node, settings }: { readonly node: Extract<PanelNode, { type: 'scene' }>; readonly settings: ProjectSettings }) {
  const { patchNode } = useNodeEdit()
  const d = node.data
  // PatchShape 已剥离索引签名（issue 16）：本地回调与判别命令同严——
  // 宽键（如 scene 表单混入对白的 lines）在此即编译失败
  const patch = (p: PatchShape<SceneNodeData>) => patchNode(node.id, { nodeType: 'scene', patch: p })
  const toggleCharacter = (id: string) => {
    const on = d.characterIds.includes(id)
    patch({
      characterIds: on ? d.characterIds.filter((cid) => cid !== id) : [...d.characterIds, id],
    })
  }
  return (
    <>
      <Field label="名称">
        <input className="pw-set-input" value={d.name} onChange={(e) => patch({ name: e.target.value })} />
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
          <input className="pw-set-input" value={d.time} onChange={(e) => patch({ time: e.target.value })} />
        </Field>
      </div>
      <Field label="天气">
        <input
          className="pw-set-input"
          value={d.weather ?? ''}
          placeholder="可选"
          onChange={(e) => patch({ weather: e.target.value })}
        />
      </Field>
      <SceneInteriorSegment interior={d.interior} onPick={(value) => patch({ interior: value })} />
      <Field label="梗概">
        <textarea
          className="pw-set-input"
          rows={3}
          value={d.synopsis}
          onChange={(e) => patch({ synopsis: e.target.value })}
        />
      </Field>
      <SceneCastChips characterIds={d.characterIds} characters={settings.characters} onToggle={toggleCharacter} />
      <EpisodeField nodeType="scene" nodeId={node.id} episodeNo={d.episodeNo} />
    </>
  )
}

/** 节奏卡表单：内容 + 基调。 */
function BeatForm({ node }: { readonly node: Extract<PanelNode, { type: 'beat' }> }) {
  const { patchNode } = useNodeEdit()
  return (
    <>
      <Field label="内容">
        <input
          className="pw-set-input"
          value={node.data.name}
          onChange={(e) => patchNode(node.id, { nodeType: 'beat', patch: { name: e.target.value } })}
        />
      </Field>
      <Field label="基调">
        <input
          className="pw-set-input"
          value={node.data.tone}
          onChange={(e) => patchNode(node.id, { nodeType: 'beat', patch: { tone: e.target.value } })}
        />
      </Field>
      <EpisodeField nodeType="beat" nodeId={node.id} episodeNo={node.data.episodeNo} />
    </>
  )
}

/** 单行台词行（行类型切换、说话人、删除、文本）：DialogueForm 拆出的分区。
 * 行级补丁以 Partial<DialogueLine> 上报，列表装配留在表单内。 */
function DialogueLineRow({
  line,
  defaultSpeaker,
  characters,
  onPatch,
  onRemove,
}: {
  readonly line: DialogueLine
  readonly defaultSpeaker?: string
  readonly characters: ProjectSettings['characters']
  readonly onPatch: (patch: Partial<DialogueLine>) => void
  readonly onRemove: () => void
}) {
  return (
    <div className="pw-set-line">
      <div className="pw-set-line-bar">
        <select
          className="pw-set-input pw-set-kind"
          value={line.kind}
          aria-label="行类型"
          onChange={(e) => {
            if (e.target.value === 'action') {
              onPatch({ kind: 'action', speaker: undefined, side: undefined })
            } else {
              onPatch({ kind: 'line', speaker: defaultSpeaker, side: 'left' })
            }
          }}
        >
          <option value="line">台词</option>
          <option value="action">动作</option>
        </select>
        {line.kind === 'line' && (
          <select
            className="pw-set-input pw-set-speaker"
            value={line.speaker ?? ''}
            aria-label="说话人"
            onChange={(e) => onPatch({ speaker: e.target.value || undefined })}
          >
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <span className="pw-sp" />
        <button type="button" className="pw-set-x" aria-label="删除此行" onClick={onRemove}>
          ✕
        </button>
      </div>
      <input
        className="pw-set-input"
        value={line.text}
        placeholder={line.kind === 'action' ? '动作描述…' : '台词内容…'}
        onChange={(e) => onPatch({ text: e.target.value })}
      />
    </div>
  )
}

/** 对白表单：名称 + 台词列表（台词/动作、说话人、增删）。@ 提及与排序随后续任务。
 * patch 回调在表单内收口 nodeType 判别字段。 */
function DialogueForm({
  node,
  settings,
}: {
  readonly node: Extract<PanelNode, { type: 'dialogue' }>
  readonly settings: ProjectSettings
}) {
  const { patchNode } = useNodeEdit()
  const defaultSpeaker = settings.characters[0]?.id
  const d = node.data
  const patch = (p: PatchShape<DialogueNodeData>) => patchNode(node.id, { nodeType: 'dialogue', patch: p })
  const patchLine = (i: number, linePatch: Partial<DialogueLine>) =>
    patch({ lines: d.lines.map((l, idx) => (idx === i ? { ...l, ...linePatch } : l)) })
  return (
    <>
      <Field label="名称">
        <input className="pw-set-input" value={d.name} onChange={(e) => patch({ name: e.target.value })} />
      </Field>
      <div className="pw-set-label">台词</div>
      {d.lines.map((line, i) => (
        <DialogueLineRow
          key={line.id}
          line={line}
          defaultSpeaker={defaultSpeaker}
          characters={settings.characters}
          onPatch={(linePatch) => patchLine(i, linePatch)}
          onRemove={() => patch({ lines: d.lines.filter((_, idx) => idx !== i) })}
        />
      ))}
      <button
        type="button"
        className="pw-set-add"
        onClick={() =>
          patch({
            lines: [...d.lines, { id: uid('line'), kind: 'line', speaker: defaultSpeaker, side: 'left', text: '' }],
          })
        }
      >
        ＋ 添加台词
      </button>
      <EpisodeField nodeType="dialogue" nodeId={node.id} episodeNo={d.episodeNo} />
    </>
  )
}

/** 分支表单：问句 + 选项增删（排序随后续任务）。 */
function BranchForm({ node }: { readonly node: Extract<PanelNode, { type: 'branch' }> }) {
  const { patchNode } = useNodeEdit()
  const d = node.data
  return (
    <>
      <Field label="问句">
        <input
          className="pw-set-input"
          value={d.prompt}
          onChange={(e) => patchNode(node.id, { nodeType: 'branch', patch: { prompt: e.target.value } })}
        />
      </Field>
      <div className="pw-set-label">选项</div>
      {d.options.map((option, i) => (
        <div key={option.id} className="pw-set-line">
          <div className="pw-set-line-bar">
            <span className="pw-set-optno">{String.fromCodePoint(65 + i)}</span>
            <span className="pw-sp" />
            <button
              type="button"
              className="pw-set-x"
              aria-label="删除此选项"
              onClick={() =>
                patchNode(node.id, {
                  nodeType: 'branch',
                  patch: { options: d.options.filter((_, idx) => idx !== i) },
                })
              }
            >
              ✕
            </button>
          </div>
          <input
            className="pw-set-input"
            value={option.label}
            onChange={(e) =>
              patchNode(node.id, {
                nodeType: 'branch',
                patch: { options: d.options.map((o, idx) => (idx === i ? { ...o, label: e.target.value } : o)) },
              })
            }
          />
        </div>
      ))}
      <button
        type="button"
        className="pw-set-add"
        onClick={() =>
          patchNode(node.id, {
            nodeType: 'branch',
            patch: { options: [...d.options, { id: uid('opt'), label: `选项 ${String.fromCodePoint(65 + d.options.length)}` }] },
          })
        }
      >
        ＋ 添加选项
      </button>
      <EpisodeField nodeType="branch" nodeId={node.id} episodeNo={d.episodeNo} />
    </>
  )
}

const REF_KIND_LABELS: Record<ShotRef['kind'], string> = {
  character: '角色垫图',
  location: '场景底图',
  audio: '音频',
}

/** 资产 MIME 解析（§7.1）：own 属性判定防原型链键误命中（库内键控桶
 * 同款口径）；悬空引用（资产已删）返回 undefined——kind 切换不设限。 */
function assetMimeOf(assets: ProjectContent['assets'], id: string): string | undefined {
  const byId = assets?.byId
  if (byId === undefined || !Object.prototype.hasOwnProperty.call(byId, id)) return undefined
  const mime = byId[id].mime
  return typeof mime === 'string' ? mime : undefined
}

/** 单个引用位行（kind 切换、删除、文案/绑定输入）：ShotForm 拆出的分区。
 * 资产引用位的 kind 切换受资产 MIME 家族约束（§4.2，与归一化
 * shotRefMimeMatches 同域）：错配 kind 保存后重开只是「不可用引用」
 * 警告——在编辑边界直接禁用，不产出注定不可用的引用。 */
function ShotRefRow({
  shotRef,
  assets,
  onKind,
  onRemove,
  onLabel,
}: {
  readonly shotRef: ShotRef
  readonly assets: ProjectContent['assets']
  readonly onKind: (kind: ShotRef['kind']) => void
  readonly onRemove: () => void
  readonly onLabel: (text: string) => void
}) {
  return (
    <div className="pw-set-line">
      <div className="pw-set-line-bar">
        <select
          className="pw-set-input pw-set-kind"
          value={shotRef.kind}
          aria-label="引用类型"
          onChange={(e) => onKind(e.target.value as ShotRef['kind'])}
        >
          {Object.entries(REF_KIND_LABELS).map(([kind, label]) => {
            const mime =
              shotRef.assetId !== undefined ? assetMimeOf(assets, shotRef.assetId) : undefined
            return (
              <option
                key={kind}
                value={kind}
                disabled={mime !== undefined && !shotRefMimeMatches(kind, mime)}
              >
                {label}
              </option>
            )
          })}
        </select>
        <span className="pw-sp" />
        <button type="button" className="pw-set-x" aria-label="删除此引用" onClick={onRemove}>
          ✕
        </button>
      </div>
      <input
        className="pw-set-input"
        value={shotRef.label ?? ''}
        placeholder={
          shotRef.assetId !== undefined
            ? `资产引用 ${shotRef.assetId}——输入文字将转为自由文案`
            : undefined
        }
        onChange={(e) => onLabel(e.target.value)}
      />
    </div>
  )
}

/** 分镜卡表单：镜号/景别/画面描述/镜头 Prompt/引用位（增删改）。
 * patch 回调在表单内收口 nodeType 判别字段；引用位行为见 ShotRefRow。 */
function ShotForm({ node }: { readonly node: Extract<PanelNode, { type: 'shot' }> }) {
  const { patchNode, assets } = useNodeEdit()
  const d = node.data
  const patch = (p: PatchShape<ShotNodeData>) => patchNode(node.id, { nodeType: 'shot', patch: p })
  return (
    <>
      <div className="pw-set-cols">
        <Field label="镜号">
          <input
            className="pw-set-input"
            type="number"
            min={1}
            value={d.shotNo}
            onChange={(e) => {
              // 非法输入回退 1；§4.1 正安全整数域：有限但越界（如 1e20）同属非法
              const n = Math.max(1, Math.floor(Number(e.target.value)))
              patch({ shotNo: Number.isSafeInteger(n) ? n : 1 })
            }}
          />
        </Field>
        <Field label="景别">
          <input className="pw-set-input" value={d.size} onChange={(e) => patch({ size: e.target.value })} />
        </Field>
      </div>
      <Field label="画面描述">
        <textarea
          className="pw-set-input"
          rows={2}
          value={d.picture}
          onChange={(e) => patch({ picture: e.target.value })}
        />
      </Field>
      <Field label="镜头 PROMPT">
        <textarea
          className="pw-set-input"
          rows={3}
          value={d.prompt}
          onChange={(e) => patch({ prompt: e.target.value })}
        />
      </Field>
      <div className="pw-set-label">引用位</div>
      {d.refs.map((ref, i) => (
        <ShotRefRow
          key={ref.id}
          shotRef={ref}
          assets={assets}
          onKind={(kind) =>
            patch({ refs: d.refs.map((r, idx) => (idx === i ? { ...r, kind } : r)) })
          }
          onRemove={() => patch({ refs: d.refs.filter((_, idx) => idx !== i) })}
          onLabel={(text) =>
            patch({
              // 输入文字即切换为自由位（§4.2 assetId/label 互斥）：剥离
              // assetId 而非并存——双字段形态保存成功但下次加载被归一化
              // 静默删除，用户输入凭空丢失
              refs: d.refs.map((r, idx) => (idx === i ? { id: r.id, kind: r.kind, label: text } : r)),
            })
          }
        />
      ))}
      <button
        type="button"
        className="pw-set-add"
        onClick={() => patch({ refs: [...d.refs, { id: uid('ref'), kind: 'character', label: '' }] })}
      >
        ＋ 添加引用
      </button>
      <p className="pw-set-empty">集归属随宿主场景（下挂索引卡）。</p>
    </>
  )
}

/**
 * 设置面板外壳：按节点类型分发表单；底部 ⧉ 复制 / 🗑 删除（§4.3）。
 * 由各节点组件在 openSettingsId 命中时渲染于卡片下方。
 */
export default function NodeSettingsPanel({ node }: { readonly node: PanelNode }) {
  const { duplicateNode, deleteNode, settings } = useNodeEdit()

  return (
    // 内嵌表单面板而非模态对话框：原生 section 地标（S6819），不冒用 dialog 角色
    <section
      className="pw-settings nodrag nowheel"
      data-pw-settings
      aria-label="节点设置"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="pw-settings-scroll">
        {node.type === 'scene' && <SceneForm node={node} settings={settings} />}
        {node.type === 'beat' && <BeatForm node={node} />}
        {node.type === 'dialogue' && <DialogueForm node={node} settings={settings} />}
        {node.type === 'branch' && <BranchForm node={node} />}
        {node.type === 'shot' && <ShotForm node={node} />}
        {node.type === 'image' && <ImageNodeForm node={node} />}
      </div>
      <div className="pw-settings-actions">
        <button
          type="button"
          className="pw-set-action"
          onClick={() => duplicateNode(node.id)}
        >
          ⧉ 复制
        </button>
        <span className="pw-sp" />
        <button
          type="button"
          className="pw-set-action pw-set-danger"
          onClick={() => deleteNode(node.id)}
        >
          🗑 删除
        </button>
      </div>
    </section>
  )
}

/**
 * 双击内联改名（docs/ui-design.md §4.3 名称在卡片头部；§3.3 项目名单击改名）。
 * 双击进入编辑（节点名称），或单击进入（工具栏项目名，singleClick）；
 * Enter/失焦提交、Esc 取消；空值不提交。非编辑态是原生 button：
 * Tab 可聚焦，Enter/Space 进入编辑（S1082/S6848）。
 */
export function EditableName({
  value,
  onChange,
  ariaLabel,
  singleClick = false,
}: {
  readonly value: string
  readonly onChange: (next: string) => void
  readonly ariaLabel: string
  /** true = 单击进入编辑（工具栏项目名）；默认双击（节点名称）。 */
  readonly singleClick?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  const beginEdit = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    setDraft(value)
    setEditing(true)
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="pw-editable"
        title={singleClick ? '点击重命名' : '双击改名'}
        onClick={singleClick ? beginEdit : undefined}
        onDoubleClick={singleClick ? undefined : beginEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            // preventDefault 抑制按钮原生 click，避免键盘激活重复触发
            e.preventDefault()
            beginEdit(e)
          }
        }}
      >
        {value}
      </button>
    )
  }
  return (
    <input
      className="pw-rename nodrag"
      autoFocus
      aria-label={ariaLabel}
      value={draft}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false)
        const next = draft.trim()
        if (next && next !== value) onChange(next)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(value)
          setEditing(false)
        }
      }}
    />
  )
}
