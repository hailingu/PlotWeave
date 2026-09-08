import Field from './Field'
import { useNodeEdit } from '../../nodeEdit'

/** 集归属（§3.5：集 = 编号 + 行内标题，节点以 episodeNo 归属集）。
 * 清空 = 移出所有集；分镜卡随宿主场景（attach 派生），不出此字段。
 * 场景/节奏/对白/分支四类表单共享（issue #39 自 NodeSettingsPanel 拆出）。 */
export default function EpisodeField({
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
