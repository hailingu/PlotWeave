import { useEffect, useRef, type RefObject } from 'react'
import { isCompositionKey } from '../platform/compositionKey'

/** 键盘边界收集弹窗内可聚焦控件的选择器（控件与正序 tabindex）。 */
const FOCUSABLE_SELECTOR =
  'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'

/**
 * 共享模态键盘边界（issues #263/#595/#803）：编辑器导出/文档弹窗与首页/
 * 资产库删除确认框共用。打开即把焦点移入弹窗首控件；Tab/Shift+Tab 在
 * 弹窗内首尾环绕，焦点逸出到背景元素时按方向拉回；Escape 关闭（输入法
 * 组合键让位）；卸载（Esc/遮罩/✕/父层状态任一路径）把焦点归还打开前
 * 最后聚焦的元素——键盘打开即触发控件；macOS WebKit 指针打开不聚焦
 * 按钮，归还打开前焦点所在（通常 body，指针流无键盘上下文可归还），
 * 与 issue #263「恢复到合理触发位置」的语义一致。returnFocusTo 覆盖该
 * 回落（#803）：键盘经同批卸载控件（首页菜单项）进入的对话框优先归还
 * 该目标——仍连接才聚焦，已分离回落打开前焦点，绝不聚焦已分离节点。
 * 视觉与指针遮罩之外补齐键盘模态语义（dialog 标注 aria-modal 配合；
 * 背景全局快捷键的挂起在 useEditorHotkeys）。onClose 与 returnFocusTo
 * 经 latest-ref 消费：父层（EditorOverlays）每渲染传新内联闭包，边界
 * 不得因闭包标识变化重挂（重挂会把焦点闪归还）。自 editor/ 提取至 ui/
 * （#803）：外壳层（home）不得运行期依赖 editor/**（issue #399 方向
 * 守卫），共享模态能力归属共享 UI 层。
 */
export function useModalKeyboard(
  dialogRef: RefObject<HTMLDialogElement | null>,
  onClose: () => void,
  returnFocusTo?: HTMLElement | null,
) {
  const onCloseRef = useRef(onClose)
  const returnFocusRef = useRef(returnFocusTo)
  useEffect(() => {
    onCloseRef.current = onClose
    returnFocusRef.current = returnFocusTo
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
      const preferred = returnFocusRef.current
      if (preferred?.isConnected) preferred.focus()
      else trigger?.focus()
    }
  }, [dialogRef])
}
