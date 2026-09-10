import { type BatchValidation } from '../ai/commands'

const ITEM_ICONS: Record<BatchValidation['items'][number]['kind'], string> = {
  create: '＋',
  update: '✎',
  connect: '⟶',
  disconnect: '⤫',
  delete: '🗑',
  // 设定实体条目（issue 44）：与节点创建/修改同列，标签自明种类
  create_entity: '＋',
  update_entity: '✎',
}

/** 执行按钮文案：含删除时按武装态分两步（S3358 独立成函数）。 */
function executeLabel(v: BatchValidation, armed: boolean): string {
  if (!v.hasDeletes) return '✓ 执行改动'
  if (armed) return '再点一次确认执行删除'
  return `执行（含 ${v.items.filter((i) => i.danger).length} 项删除）`
}

/**
 * 改动预览卡（§6）：整卡 = 一个 batch 命令。删除项 danger 置顶
 * （校验器已排序）；含删除时执行需两步确认，不提供自动执行开关。
 * 会话条目的挂载与执行回执在 AiThread.tsx（issue #39 拆分）。
 */
export default function PreviewCard({
  v,
  status,
  historical,
  armed,
  busy,
  onArm,
  onExecute,
  onDismiss,
}: {
  readonly v: BatchValidation
  readonly status: 'pending' | 'executed' | 'dismissed'
  /** 跨会话恢复的历史执行卡：撤销栈已重建，不宣称 ⌘Z 可整批撤销。 */
  readonly historical?: boolean
  readonly armed: boolean
  readonly busy: boolean
  readonly onArm: () => void
  readonly onExecute: () => void
  readonly onDismiss: () => void
}) {
  if (status === 'dismissed') return null
  return (
    // 原生 section 地标承载分组语义（S6819）
    <section className={`pw-ai-card${v.hasDeletes ? ' danger' : ''}`} aria-label="AI 改动预览">
      <div className="pw-ai-card-head">✦ 改动预览 · {v.commands.length} 项</div>
      {!v.ok && (
        <ul className="pw-ai-issues">
          {v.issues.map((iss) => (
            <li key={iss.index} className="pw-ai-issue">第 {iss.index + 1} 条：{iss.message}</li>
          ))}
        </ul>
      )}
      {v.ok && (
        <ul className="pw-ai-items">
          {v.items.map((item) => (
            <li key={item.key} className={`pw-ai-item${item.danger ? ' danger' : ''}`}>
              <span className="pw-ai-item-icon" aria-hidden>{ITEM_ICONS[item.kind]}</span>
              {item.label}
            </li>
          ))}
        </ul>
      )}
      <div className="pw-ai-actions">
        {status === 'executed' ? (
          <span className="pw-ai-note">{historical ? '✓ 已执行（历史改动）' : '✓ 已执行，⌘Z 可整批撤销'}</span>
        ) : (
          <>
            <button
              type="button"
              className="pw-ai-btn"
              disabled={!v.ok || busy}
              onClick={onDismiss}
            >
              忽略
            </button>
            <button
              type="button"
              className={`pw-ai-btn primary${v.hasDeletes ? ' danger' : ''}`}
              disabled={!v.ok || busy}
              onClick={() => {
                if (!v.hasDeletes || armed) onExecute()
                else onArm()
              }}
            >
              {executeLabel(v, armed)}
            </button>
          </>
        )}
      </div>
      {!v.ok && <div className="pw-ai-note">批次未通过校验，画布未发生任何变化。</div>}
    </section>
  )
}
