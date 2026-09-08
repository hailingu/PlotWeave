import Field from './Field'
import EpisodeField from './EpisodeField'
import { useCompositionSafeValue } from './compositionValue'
import { useNodeEdit } from '../../nodeEdit'
import type { BeatNodeData } from '../types'
import type { PatchShape } from '../patch'
import type { PanelNode } from './NodeSettingsPanel'

/** 节奏卡表单：内容 + 基调（自由文本缓冲中文组合输入，issue #42）。
 * 自 NodeSettingsPanel.tsx 外置（issue #39，ImageNodeForm.tsx 先例）。 */
export default function BeatForm({ node }: { readonly node: Extract<PanelNode, { type: 'beat' }> }) {
  const { patchNode } = useNodeEdit()
  const d = node.data
  const patch = (p: PatchShape<BeatNodeData>) => patchNode(node.id, { nodeType: 'beat', patch: p })
  const name = useCompositionSafeValue(d.name, (next) => patch({ name: next }))
  const tone = useCompositionSafeValue(d.tone, (next) => patch({ tone: next }))
  return (
    <>
      <Field label="内容">
        <input className="pw-set-input" {...name} />
      </Field>
      <Field label="基调">
        <input className="pw-set-input" {...tone} />
      </Field>
      <EpisodeField nodeType="beat" nodeId={node.id} episodeNo={d.episodeNo} />
    </>
  )
}
