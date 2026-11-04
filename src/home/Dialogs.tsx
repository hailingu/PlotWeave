import { DialogFooter } from '../ui/DialogFooter'
import { useModalKeyboard } from '../ui/useModalKeyboard'
import { useEffect, useRef, useState } from 'react'
import { isCompositionKey } from '../platform/compositionKey'

/**
 * 首页对话框组（docs/ui-design.md §3.2 右键/悬停菜单的承载）：
 * 重命名（输入框，Enter 提交 / Esc 取消）与删除确认
 * （HIG：仅真正不可逆操作使用确认对话框）。
 * 复用编辑器的 pw-overlay / pw-dialog 材质样式。
 * ConfirmDeleteDialog 泛化为 title/message 承载：首页删项目与资产库
 * 删资产共用——原生 window.confirm 在 Tauri WKWebView 无 UI 代理实现、
 * 静默返回 false，不可逆确认一律走应用内对话框。
 * 组合在途的 Enter/Esc 归输入法（不提交/不取消，issue #570）。
 * 删除确认是模态（#803）：焦点进入/Tab 圈定/关闭归还由共享
 * useModalKeyboard 统一管理；重命名沿用自身输入框焦点入口。
 */

interface RenameDialogProps {
  /** 当前项目名，作为输入初值。 */
  readonly currentName: string
  readonly onCancel: () => void
  readonly onConfirm: (name: string) => void
}

/** 重命名对话框（§3.2）：Enter 提交 / Esc 取消，输入初值为当前项目名。 */
export function RenameDialog({
  currentName,
  onCancel,
  onConfirm,
}: RenameDialogProps) {
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
              if (isCompositionKey(e.nativeEvent)) return
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') onCancel()
            }}
          />
        </div>
        <DialogFooter
          secondary={{ label: '取消', onClick: onCancel }}
          primary={{ label: '重命名', onClick: submit, disabled: !name.trim() }}
        />
      </dialog>
    </div>
  )
}

interface ConfirmDeleteDialogProps {
  /** 对话框标题（如「删除项目」「删除资产」），同时作 aria-label。 */
  readonly title: string
  /** 正文：指名被删对象与不可撤销后果。 */
  readonly message: string
  /** 关闭时优先归还焦点的目标（#803）：键盘经同批卸载控件（首页菜单项）
   * 打开时传原触发钮；未传或已分离则回落打开前焦点（useModalKeyboard）。 */
  readonly returnFocusTo?: HTMLElement | null
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

/** 不可逆操作的确认对话框（§3.2）：title/message 泛化承载——首页删项目
 * 与资产库删资产共用；原生 confirm 在 Tauri WKWebView 不可用（见模块头）。
 * 模态键盘边界（焦点移入/Tab 循环/关闭归还/Esc，含组合键让位）由共享
 * useModalKeyboard 统一管理（#803）。 */
export function ConfirmDeleteDialog({
  title,
  message,
  returnFocusTo,
  onCancel,
  onConfirm,
}: ConfirmDeleteDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useModalKeyboard(dialogRef, onCancel, returnFocusTo)

  return (
    <div className="pw-overlay" onPointerDown={onCancel}>
      {/* 原生 dialog 承载对话框语义（S6819）；非模态 open 标记 + aria-modal，
          键盘模态边界（焦点移入/Tab 循环/关闭归还/Esc）见 useModalKeyboard */}
      <dialog
        ref={dialogRef}
        open
        className="pw-dialog pw-dialog-sm"
        aria-label={title}
        aria-modal="true"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="pw-dialog-head">
          <b>{title}</b>
        </div>
        <div className="pw-dialog-body">
          <p className="pw-dialog-text">{message}</p>
        </div>
        <DialogFooter
          secondary={{ label: '取消', onClick: onCancel }}
          primary={{ label: '删除', onClick: onConfirm }}
          primaryKind="danger"
        />
      </dialog>
    </div>
  )
}
