import Field from './Field'
import EpisodeField from './EpisodeField'
import { useCompositionSafeValue } from './compositionValue'
import { useNodeEdit } from '../../nodeEdit'
import { uid } from '../../../uid'
import type { BranchOption } from '../types'
import type { PanelNode } from './NodeSettingsPanel'

/** 单个分支选项行（编号、删除、文案输入）：BranchForm 拆出的分区，
 * 文案输入经 useCompositionSafeValue 缓冲中文组合输入（issue #42）。 */
function BranchOptionRow({
  option,
  index,
  onLabel,
  onRemove,
}: {
  readonly option: BranchOption
  readonly index: number
  readonly onLabel: (label: string) => void
  readonly onRemove: () => void
}) {
  const label = useCompositionSafeValue(option.label, onLabel)
  return (
    <div className="pw-set-line">
      <div className="pw-set-line-bar">
        <span className="pw-set-optno">{String.fromCodePoint(65 + index)}</span>
        <span className="pw-sp" />
        <button type="button" className="pw-set-x" aria-label="删除此选项" onClick={onRemove}>
          ✕
        </button>
      </div>
      <input className="pw-set-input" {...label} />
    </div>
  )
}

/** 分支表单：问句 + 选项增删（排序随后续任务）。
 * 自 NodeSettingsPanel.tsx 外置（issue #39，ImageNodeForm.tsx 先例）。 */
export default function BranchForm({ node }: { readonly node: Extract<PanelNode, { type: 'branch' }> }) {
  const { patchNode } = useNodeEdit()
  const d = node.data
  const prompt = useCompositionSafeValue(d.prompt, (next) =>
    patchNode(node.id, { nodeType: 'branch', patch: { prompt: next } }),
  )
  return (
    <>
      <Field label="问句">
        <input className="pw-set-input" {...prompt} />
      </Field>
      <div className="pw-set-label">选项</div>
      {d.options.map((option, i) => (
        <BranchOptionRow
          key={option.id}
          option={option}
          index={i}
          onLabel={(label) =>
            patchNode(node.id, {
              nodeType: 'branch',
              patch: { options: d.options.map((o, idx) => (idx === i ? { ...o, label } : o)) },
            })
          }
          onRemove={() =>
            patchNode(node.id, {
              nodeType: 'branch',
              patch: { options: d.options.filter((_, idx) => idx !== i) },
            })
          }
        />
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
