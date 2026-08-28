import { useState, type ReactNode } from 'react'
import { useNodeEdit } from '../../nodeEdit'
import type { ProjectSettings } from '../../settings'
import { uid } from '../../../uid'
import type {
  BeatNodeData,
  BranchNodeData,
  DialogueNodeData,
  SceneNodeData,
  ShotNodeData,
  ShotRef,
} from '../types'

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

/** 表单字段行：小标签 + 控件。 */
function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="pw-set-field">
      <span className="pw-set-label">{label}</span>
      {children}
    </label>
  )
}

/** 集归属（§3.5：集 = 编号 + 行内标题，节点以 episodeNo 归属集）。
 * 清空 = 移出所有集；分镜卡随宿主场景（attach 派生），不出此字段。 */
function EpisodeField({ nodeId, episodeNo }: { readonly nodeId: string; readonly episodeNo?: number }) {
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
            const n = raw === '' ? Number.NaN : Math.max(1, Math.floor(Number(raw)))
            patchNode(nodeId, { episodeNo: Number.isFinite(n) ? n : undefined })
          }}
        />
        {episodeNo !== undefined && (
          <button
            type="button"
            className="pw-set-x"
            aria-label="移出集"
            title="移出集（未分集）"
            onClick={() => patchNode(nodeId, { episodeNo: undefined })}
          >
            ✕
          </button>
        )}
      </div>
    </Field>
  )
}

/** 场景表单：名称/地点/时间/天气/内外景/梗概/出场角色（设定集引用切换）。 */
function SceneForm({ node, settings }: { readonly node: Extract<PanelNode, { type: 'scene' }>; readonly settings: ProjectSettings }) {
  const { patchNode } = useNodeEdit()
  const d = node.data
  const toggleCharacter = (id: string) => {
    const on = d.characterIds.includes(id)
    patchNode(node.id, {
      characterIds: on
        ? d.characterIds.filter((cid) => cid !== id)
        : [...d.characterIds, id],
    })
  }
  return (
    <>
      <Field label="名称">
        <input
          className="pw-set-input"
          value={d.name}
          onChange={(e) => patchNode(node.id, { name: e.target.value })}
        />
      </Field>
      <div className="pw-set-cols">
        <Field label="地点">
          <select
            className="pw-set-input"
            value={d.locationId ?? ''}
            onChange={(e) => patchNode(node.id, { locationId: e.target.value || undefined })}
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
          <input
            className="pw-set-input"
            value={d.time}
            onChange={(e) => patchNode(node.id, { time: e.target.value })}
          />
        </Field>
      </div>
      <Field label="天气">
        <input
          className="pw-set-input"
          value={d.weather ?? ''}
          placeholder="可选"
          onChange={(e) => patchNode(node.id, { weather: e.target.value })}
        />
      </Field>
      <Field label="内外景">
        <div className="pw-set-seg">
          <button
            type="button"
            className={d.interior ? 'on' : ''}
            onClick={() => patchNode(node.id, { interior: true })}
          >
            内
          </button>
          <button
            type="button"
            className={!d.interior ? 'on' : ''}
            onClick={() => patchNode(node.id, { interior: false })}
          >
            外
          </button>
        </div>
      </Field>
      <Field label="梗概">
        <textarea
          className="pw-set-input"
          rows={3}
          value={d.synopsis}
          onChange={(e) => patchNode(node.id, { synopsis: e.target.value })}
        />
      </Field>
      <Field label="出场角色">
        <div className="pw-set-chips">
          {settings.characters.map((c) => {
            const on = d.characterIds.includes(c.id)
            return (
              <button
                key={c.id}
                type="button"
                className={`pw-set-chip${on ? ' on' : ''}`}
                onClick={() => toggleCharacter(c.id)}
                aria-pressed={on}
              >
                <span className="pw-av pw-av-sm" style={{ background: c.gradient }}>
                  {c.name.charAt(0)}
                </span>
                {c.name}
              </button>
            )
          })}
          {settings.characters.length === 0 && (
            <span className="pw-set-empty">设定集暂无角色，请在左栏新增</span>
          )}
        </div>
      </Field>
      <EpisodeField nodeId={node.id} episodeNo={d.episodeNo} />
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
          onChange={(e) => patchNode(node.id, { name: e.target.value })}
        />
      </Field>
      <Field label="基调">
        <input
          className="pw-set-input"
          value={node.data.tone}
          onChange={(e) => patchNode(node.id, { tone: e.target.value })}
        />
      </Field>
      <EpisodeField nodeId={node.id} episodeNo={node.data.episodeNo} />
    </>
  )
}

/** 对白表单：名称 + 台词列表（台词/动作、说话人、增删）。@ 提及与排序随后续任务。 */
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
  const patchLine = (i: number, patch: Record<string, unknown>) => {
    patchNode(node.id, {
      lines: d.lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)),
    })
  }
  return (
    <>
      <Field label="名称">
        <input
          className="pw-set-input"
          value={d.name}
          onChange={(e) => patchNode(node.id, { name: e.target.value })}
        />
      </Field>
      <div className="pw-set-label">台词</div>
      {d.lines.map((line, i) => (
        <div key={line.id} className="pw-set-line">
          <div className="pw-set-line-bar">
            <select
              className="pw-set-input pw-set-kind"
              value={line.kind}
              aria-label="行类型"
              onChange={(e) => {
                if (e.target.value === 'action') {
                  patchLine(i, { kind: 'action', speaker: undefined, side: undefined })
                } else {
                  patchLine(i, { kind: 'line', speaker: defaultSpeaker, side: 'left' })
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
                onChange={(e) => patchLine(i, { speaker: e.target.value || undefined })}
              >
                {settings.characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <span className="pw-sp" />
            <button
              type="button"
              className="pw-set-x"
              aria-label="删除此行"
              onClick={() =>
                patchNode(node.id, { lines: d.lines.filter((_, idx) => idx !== i) })
              }
            >
              ✕
            </button>
          </div>
          <input
            className="pw-set-input"
            value={line.text}
            placeholder={line.kind === 'action' ? '动作描述…' : '台词内容…'}
            onChange={(e) => patchLine(i, { text: e.target.value })}
          />
        </div>
      ))}
      <button
        type="button"
        className="pw-set-add"
        onClick={() =>
          patchNode(node.id, {
            lines: [...d.lines, { id: uid('line'), kind: 'line', speaker: defaultSpeaker, side: 'left', text: '' }],
          })
        }
      >
        ＋ 添加台词
      </button>
      <EpisodeField nodeId={node.id} episodeNo={d.episodeNo} />
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
          onChange={(e) => patchNode(node.id, { prompt: e.target.value })}
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
                patchNode(node.id, { options: d.options.filter((_, idx) => idx !== i) })
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
                options: d.options.map((o, idx) => (idx === i ? { ...o, label: e.target.value } : o)),
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
            options: [...d.options, { id: uid('opt'), label: `选项 ${String.fromCodePoint(65 + d.options.length)}` }],
          })
        }
      >
        ＋ 添加选项
      </button>
      <EpisodeField nodeId={node.id} episodeNo={d.episodeNo} />
    </>
  )
}

const REF_KIND_LABELS: Record<ShotRef['kind'], string> = {
  character: '角色垫图',
  location: '场景底图',
  audio: '音频',
}

/** 分镜卡表单：镜号/景别/画面描述/镜头 Prompt/引用位（增删改）。 */
function ShotForm({ node }: { readonly node: Extract<PanelNode, { type: 'shot' }> }) {
  const { patchNode } = useNodeEdit()
  const d = node.data
  return (
    <>
      <div className="pw-set-cols">
        <Field label="镜号">
          <input
            className="pw-set-input"
            type="number"
            min={1}
            value={d.shotNo}
            onChange={(e) => patchNode(node.id, { shotNo: Number(e.target.value) || 1 })}
          />
        </Field>
        <Field label="景别">
          <input
            className="pw-set-input"
            value={d.size}
            onChange={(e) => patchNode(node.id, { size: e.target.value })}
          />
        </Field>
      </div>
      <Field label="画面描述">
        <textarea
          className="pw-set-input"
          rows={2}
          value={d.picture}
          onChange={(e) => patchNode(node.id, { picture: e.target.value })}
        />
      </Field>
      <Field label="镜头 PROMPT">
        <textarea
          className="pw-set-input"
          rows={3}
          value={d.prompt}
          onChange={(e) => patchNode(node.id, { prompt: e.target.value })}
        />
      </Field>
      <div className="pw-set-label">引用位</div>
      {d.refs.map((ref, i) => (
        <div key={ref.id} className="pw-set-line">
          <div className="pw-set-line-bar">
            <select
              className="pw-set-input pw-set-kind"
              value={ref.kind}
              aria-label="引用类型"
              onChange={(e) =>
                patchNode(node.id, {
                  refs: d.refs.map((r, idx) =>
                    idx === i ? { ...r, kind: e.target.value as ShotRef['kind'] } : r,
                  ),
                })
              }
            >
              {Object.entries(REF_KIND_LABELS).map(([kind, label]) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
            <span className="pw-sp" />
            <button
              type="button"
              className="pw-set-x"
              aria-label="删除此引用"
              onClick={() => patchNode(node.id, { refs: d.refs.filter((_, idx) => idx !== i) })}
            >
              ✕
            </button>
          </div>
          <input
            className="pw-set-input"
            value={ref.label}
            onChange={(e) =>
              patchNode(node.id, {
                refs: d.refs.map((r, idx) => (idx === i ? { ...r, label: e.target.value } : r)),
              })
            }
          />
        </div>
      ))}
      <button
        type="button"
        className="pw-set-add"
        onClick={() =>
          patchNode(node.id, { refs: [...d.refs, { id: uid('ref'), kind: 'character', label: '' }] })
        }
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
