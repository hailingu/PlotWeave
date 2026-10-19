import { useEffect, useRef, type RefObject } from 'react'
import { isCompositionKey } from '../platform/compositionKey'

/** 键盘边界收集弹窗内可聚焦控件的选择器（控件与正序 tabindex）。 */
const FOCUSABLE_SELECTOR =
  'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'

/**
 * 导出与文档编辑弹窗共享的模态键盘边界（issues #263/#595）：打开即把焦点移入弹窗首控件；
 * Tab/Shift+Tab 在弹窗内首尾环绕，焦点逸出到背景元素时按方向拉回；
 * Escape 关闭（输入法组合键让位）；卸载（Esc/遮罩/✕/父层状态任一路径）把焦点归还打开前
 * 最后聚焦的元素——键盘打开即触发控件；macOS WebKit 指针打开不聚焦
 * 按钮，归还打开前焦点所在（通常 body，指针流无键盘上下文可归还），
 * 与 issue #263「恢复到合理触发位置」的语义一致。视觉与指针遮罩之外
 * 补齐键盘模态语义（dialog 标注 aria-modal 配合；背景全局快捷键的挂起
 * 在 useEditorHotkeys）。onClose 经 latest-ref 消费：父层（EditorOverlays）
 * 每渲染传新内联闭包，边界不得因闭包标识变化重挂（重挂会把焦点闪归还）。
 */
export function useModalKeyboard(
  dialogRef: RefObject<HTMLDialogElement | null>,
  onClose: () => void,
) {
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute('disabled'))
    focusables()[0]?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isCompositionKey(e)) {
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      if (!dialog.contains(active)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
        return
      }
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      trigger?.focus()
    }
  }, [dialogRef])
}
