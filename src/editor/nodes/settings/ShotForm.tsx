import Field from './Field'
import { useCompositionSafeValue } from './compositionValue'
import { useNodeEdit } from '../../nodeEdit'
import { uid } from '../../../uid'
import { shotRefMimeMatches } from '../../../model/convert'
import type { ProjectContent } from '../../../model/content'
import type { ShotNodeData, ShotRef } from '../types'
import type { PatchShape } from '../patch'
import type { PanelNode } from './NodeSettingsPanel'

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
  const label = useCompositionSafeValue(shotRef.label ?? '', onLabel)
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
        placeholder={
          shotRef.assetId !== undefined
            ? `资产引用 ${shotRef.assetId}——输入文字将转为自由文案`
            : undefined
        }
        {...label}
      />
    </div>
  )
}

/** 分镜卡表单：镜号/景别/画面描述/镜头 Prompt/引用位（增删改）。
 * patch 回调在表单内收口 nodeType 判别字段；引用位行为见 ShotRefRow。
 * 自 NodeSettingsPanel.tsx 外置（issue #39，ImageNodeForm.tsx 先例）。 */
export default function ShotForm({ node }: { readonly node: Extract<PanelNode, { type: 'shot' }> }) {
  const { patchNode, assets } = useNodeEdit()
  const d = node.data
  const patch = (p: PatchShape<ShotNodeData>) => patchNode(node.id, { nodeType: 'shot', patch: p })
  const size = useCompositionSafeValue(d.size, (next) => patch({ size: next }))
  const picture = useCompositionSafeValue(d.picture, (next) => patch({ picture: next }))
  const prompt = useCompositionSafeValue(d.prompt, (next) => patch({ prompt: next }))
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
          <input className="pw-set-input" {...size} />
        </Field>
      </div>
      <Field label="画面描述">
        <textarea className="pw-set-input" rows={2} {...picture} />
      </Field>
      <Field label="镜头 PROMPT">
        <textarea className="pw-set-input" rows={3} {...prompt} />
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
