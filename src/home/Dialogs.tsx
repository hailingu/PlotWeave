import { useEffect, useRef, useState } from 'react'

/**
 * 首页对话框组（docs/ui-design.md §3.2 右键/悬停菜单的承载）：
 * 重命名（输入框，Enter 提交 / Esc 取消）与删除确认
 * （HIG：仅真正不可逆操作使用确认对话框）。
 * 复用编辑器的 pw-overlay / pw-dialog 材质样式。
 * ConfirmDeleteDialog 泛化为 title/message 承载：首页删项目与资产库
 * 删资产共用——原生 window.confirm 在 Tauri WKWebView 无 UI 代理实现、
 * 静默返回 false，不可逆确认一律走应用内对话框。
 */

interface RenameDialogProps {
  /** 当前项目名，作为输入初值。 */
  readonly currentName: string
  readonly onCancel: () => void
  readonly onConfirm: (name: string) => void
}

export function RenameDialog({ currentName, onCancel, onConfirm }: RenameDialogProps) {
  const [name, setName] = useState(currentName)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = () => {
    const next = name.trim()
    if (next && next !== currentName) onConfirm(next)
    else onCancel()
  }

  return (
    <div className="pw-overlay" onPointerDown={onCancel}>
      {/* 原生 dialog 承载对话框语义（S6819）；非模态——焦点圈定不存在，
          手动 Esc 处理保留 */}
      <dialog
        open
        className="pw-dialog pw-dialog-sm"
        aria-label="重命名项目"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="pw-dialog-head">
          <b>重命名项目</b>
        </div>
        <div className="pw-dialog-body">
          <input
            ref={inputRef}
            className="pw-set-input"
            value={name}
            aria-label="项目名"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') onCancel()
            }}
          />
        </div>
        <div className="pw-dialog-foot">
          <span className="pw-sp" />
          <button type="button" className="pw-dialog-btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="pw-dialog-btn pw-dialog-btn-primary"
            onClick={submit}
            disabled={!name.trim()}
          >
            重命名
          </button>
        </div>
      </dialog>
    </div>
  )
}

interface ConfirmDeleteDialogProps {
  /** 对话框标题（如「删除项目」「删除资产」），同时作 aria-label。 */
  readonly title: string
  /** 正文：指名被删对象与不可撤销后果。 */
  readonly message: string
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

export function ConfirmDeleteDialog({
  title,
  message,
  onCancel,
  onConfirm,
}: ConfirmDeleteDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="pw-overlay" onPointerDown={onCancel}>
      <dialog
        open
        className="pw-dialog pw-dialog-sm"
        aria-label={title}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="pw-dialog-head">
          <b>{title}</b>
        </div>
        <div className="pw-dialog-body">
          <p className="pw-dialog-text">{message}</p>
        </div>
        <div className="pw-dialog-foot">
          <span className="pw-sp" />
          <button type="button" className="pw-dialog-btn" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="pw-dialog-btn pw-dialog-danger" onClick={onConfirm}>
            删除
          </button>
        </div>
      </dialog>
    </div>
  )
}
