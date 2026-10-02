import { Field } from './Field'
import { EpisodeField } from './EpisodeField'
import { useCompositionSafeValue } from './compositionValue'
import { useNodeEdit } from '../../nodeEdit'
import { uid } from '../../../uid'
import type { ProjectSettings } from '../../settings'
import type { DialogueLine, DialogueNodeData, LinePatch } from '../types'
import type { PatchShape } from '../patch'
import type { PanelNode } from './panelNode'

/** 行合并（issue #231）：LinePatch 的显式 undefined 覆盖清除可选字段；
 * undefined 键与缺省在运行时等价（归一化按字段读取、序列化剥离），
 * cast 只表达这一等价，合并语义与历史 spread 逐字一致。 */
function mergeLine(l: DialogueLine, linePatch: LinePatch): DialogueLine {
  return { ...l, ...linePatch } as DialogueLine
}

/** 单行台词行（行类型切换、说话人、删除、文本）：DialogueForm 拆出的分区。
 * 行级补丁以 LinePatch 上报（允许显式 undefined 清除可选字段，issue
 * #231），列表装配留在表单内。 */
function DialogueLineRow({
  line,
  defaultSpeaker,
  characters,
  onPatch,
  onRemove,
}: {
  readonly line: DialogueLine
  /** 上游持有 string | undefined（无默认说话人 = 不预填）；显式 undefined
   * 与缺省在此 prop 上语义等价（issue #231）。 */
  readonly defaultSpeaker?: string | undefined
  readonly characters: ProjectSettings['characters']
  readonly onPatch: (patch: LinePatch) => void
  readonly onRemove: () => void
}) {
  const text = useCompositionSafeValue(line.text, (next) =>
    onPatch({ text: next }),
  )
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
        <button
          type="button"
          className="pw-set-x"
          aria-label="删除此行"
          onClick={onRemove}
        >
          ✕
        </button>
      </div>
      <input
        className="pw-set-input"
        placeholder={line.kind === 'action' ? '动作描述…' : '台词内容…'}
        {...text}
      />
    </div>
  )
}

/** 对白表单：名称 + 台词列表（台词/动作、说话人、增删）。@ 提及与排序随后续任务。
 * patch 回调在表单内收口 nodeType 判别字段。
 * 自 NodeSettingsPanel.tsx 外置（issue #39，ImageNodeForm.tsx 先例）。 */
export function DialogueForm({
  node,
  settings,
}: {
  readonly node: Extract<PanelNode, { type: 'dialogue' }>
  readonly settings: ProjectSettings
}) {
  const { patchNode } = useNodeEdit()
  const defaultSpeaker = settings.characters[0]?.id
  const d = node.data
  const patch = (p: PatchShape<DialogueNodeData>) =>
    patchNode(node.id, { nodeType: 'dialogue', patch: p })
  const name = useCompositionSafeValue(d.name, (next) => patch({ name: next }))
  const patchLine = (i: number, linePatch: LinePatch) =>
    patch({
      lines: d.lines.map((l, idx) => (idx === i ? mergeLine(l, linePatch) : l)),
    })
  return (
    <>
      <Field label="名称">
        <input className="pw-set-input" {...name} />
      </Field>
      <div className="pw-set-label">台词</div>
      {d.lines.map((line, i) => (
        <DialogueLineRow
          key={line.id}
          line={line}
          defaultSpeaker={defaultSpeaker}
          characters={settings.characters}
          onPatch={(linePatch) => patchLine(i, linePatch)}
          onRemove={() =>
            patch({ lines: d.lines.filter((_, idx) => idx !== i) })
          }
        />
      ))}
      <button
        type="button"
        className="pw-set-add"
        onClick={() =>
          patch({
            lines: [
              ...d.lines,
              {
                id: uid('line'),
                kind: 'line',
                ...(defaultSpeaker !== undefined && {
                  speaker: defaultSpeaker,
                }),
                side: 'left',
                text: '',
              },
            ],
          })
        }
      >
        ＋ 添加台词
      </button>
      <EpisodeField
        nodeType="dialogue"
        nodeId={node.id}
        episodeNo={d.episodeNo}
      />
    </>
  )
}
