import type { ReactNode } from 'react'

/** 页脚动作只描述既有按钮；草稿、确认与交付状态仍由调用方拥有。 */
interface DialogAction {
  readonly label: string
  readonly onClick: () => void
  readonly disabled?: boolean
}

const BUTTON_CLASSES = {
  normal: 'pw-dialog-btn',
  primary: 'pw-dialog-btn pw-dialog-btn-primary',
  danger: 'pw-dialog-btn pw-dialog-danger',
}

/** 统一 type/button 与样式接线，不添加事件包装或额外 DOM。 */
function ActionButton({
  action,
  kind = 'normal',
}: {
  readonly action: DialogAction
  readonly kind?: keyof typeof BUTTON_CLASSES
}) {
  return (
    <button
      type="button"
      className={BUTTON_CLASSES[kind]}
      disabled={action.disabled}
      onClick={action.onClick}
    >
      {action.label}
    </button>
  )
}

/** 四类 Web 对话框共享的页脚骨架；提示/格式控件先于间隔与动作，键盘和焦点仍属原对话框。 */
export function DialogFooter({
  children,
  primary,
  secondary,
  primaryKind = 'primary',
  className,
}: {
  readonly children?: ReactNode
  readonly primary: DialogAction
  readonly secondary?: DialogAction
  readonly primaryKind?: 'primary' | 'danger'
  readonly className?: string
}) {
  return (
    <div
      className={className ? `pw-dialog-foot ${className}` : 'pw-dialog-foot'}
    >
      {children}
      <span className="pw-sp" />
      {secondary && <ActionButton action={secondary} />}
      <ActionButton action={primary} kind={primaryKind} />
    </div>
  )
}
