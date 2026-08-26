import { useEffect, useRef, useState } from 'react'

/**
 * 首页对话框组（docs/ui-design.md §3.2 右键/悬停菜单的承载）：
 * 重命名（输入框，Enter 提交 / Esc 取消）与删除确认
 * （HIG：仅真正不可逆操作使用确认对话框）。
 * 复用编辑器的 pw-overlay / pw-dialog 材质样式。
 */

interface RenameDialogProps {
  /** 当前项目名，作为输入初值。 */
  currentName: string
  onCancel: () => void
  onConfirm: (name: string) => void
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
    <div className="pw-overlay" onPointerDown={onCancel} role="presentation">
      <div
        className="pw-dialog pw-dialog-sm"
        role="dialog"
        aria-modal="true"
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
      </div>
    </div>
  )
}

interface ConfirmDeleteDialogProps {
  projectName: string
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDeleteDialog({
  projectName,
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
    <div className="pw-overlay" onPointerDown={onCancel} role="presentation">
      <div
        className="pw-dialog pw-dialog-sm"
        role="dialog"
        aria-modal="true"
        aria-label="删除项目"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="pw-dialog-head">
          <b>删除项目</b>
        </div>
        <div className="pw-dialog-body">
          <p className="pw-dialog-text">
            删除「{projectName}」？项目文件将从磁盘移除，此操作不可撤销。
          </p>
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
      </div>
    </div>
  )
}
