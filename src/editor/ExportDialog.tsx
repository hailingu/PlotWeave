import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ScriptExportModel } from './exportScript'
import { useScriptExportActions } from './useScriptExportActions'

interface ExportDialogProps {
  /** 项目名，用于标题与默认文件名。 */
  readonly projectName: string
  /** 一次生成结果：正文与可选大纲两个全文 + 导出范围概要。 */
  readonly model: ScriptExportModel
  readonly onClose: () => void
}

/** 导出对话框脚部（issue #99 拆分）：大纲开关（切换即清复制回执）、
 * 内容提示与复制/下载操作；开关只切换同一生成结果的文本。 */
function ExportDialogFoot({
  showOutline,
  onToggleOutline,
  hint,
  copied,
  copyAll,
  download,
}: {
  readonly showOutline: boolean
  readonly onToggleOutline: (checked: boolean) => void
  readonly hint: string
  readonly copied: boolean
  readonly copyAll: () => void
  readonly download: () => void
}) {
  return (
    <div className="pw-dialog-foot">
      <label className="pw-export-toggle">
        <input
          type="checkbox"
          checked={showOutline}
          onChange={(e) => onToggleOutline(e.target.checked)}
        />
        <span>创作大纲（节奏与分支）</span>
      </label>
      <span className="pw-dialog-hint">{hint}</span>
      <span className="pw-sp" />
      <button type="button" className="pw-dialog-btn" onClick={copyAll}>
        {copied ? '✓ 已复制' : '复制全文'}
      </button>
      <button
        type="button"
        className="pw-dialog-btn pw-dialog-btn-primary"
        onClick={download}
      >
        下载 .md
      </button>
    </div>
  )
}

/** 根据实际内容与开关态提示：仅有节拍/分支时引导开启大纲，无故事内容则说明
 * 空态；既有叙事又有分支且大纲关闭时明示分支未包含并引导并入（issue #361，
 * 默认导出路径不允许静默丢弃分支结构）。 */
function bodyHint(
  showOutline: boolean,
  hasNarrative: boolean,
  hasOutline: boolean,
  branches: number,
): string {
  if (!hasNarrative && !hasOutline) return '暂无可导出的场景、对白、节奏或分支'
  if (showOutline) return '正文 = 场景 + 对白；创作大纲与分镜卡为附录'
  if (!hasNarrative)
    return '正文为空（尚无场景与对白）；开启「创作大纲」可查看节奏与分支'
  if (branches > 0)
    return `正文 = 场景 + 对白；${branches} 处分支未包含在正文中，开启「创作大纲」附录可并入`
  return '正文 = 场景 + 对白；分镜卡见附录'
}

/** 键盘边界收集弹窗内可聚焦控件的选择器（控件与正序 tabindex）。 */
const FOCUSABLE_SELECTOR =
  'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'

/**
 * 导出对话框的模态键盘边界（issue #263）：打开即把焦点移入弹窗首控件；
 * Tab/Shift+Tab 在弹窗内首尾环绕，焦点逸出到背景元素时按方向拉回；
 * Escape 关闭；卸载（Esc/遮罩/✕/父层状态任一路径）把焦点归还打开前
 * 最后聚焦的元素——键盘打开即触发控件；macOS WebKit 指针打开不聚焦
 * 按钮，归还打开前焦点所在（通常 body，指针流无键盘上下文可归还），
 * 与 issue #263「恢复到合理触发位置」的语义一致。视觉与指针遮罩之外
 * 补齐键盘模态语义（dialog 标注 aria-modal 配合；背景全局快捷键的挂起
 * 在 useEditorHotkeys）。onClose 经 latest-ref 消费：父层（EditorOverlays）
 * 每渲染传新内联闭包，边界不得因闭包标识变化重挂（重挂会把焦点闪归还）。
 */
function useExportModalKeyboard(
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
      if (e.key === 'Escape') {
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

/**
 * 剧本导出对话框（docs/ui-design.md §3.3 导出、§3.5 剧本导出）。
 * 预览生成的正文（场景 + 对白，节拍/分支不进正文）与附录；
 * 「创作大纲」开关默认关闭，开启后在文末并入大纲附录（节奏名称/基调、分支问句
 * 与选项去向）——开关只切换同一生成结果的文本，不改动画布或项目实体，并清除
 * 上一变体的复制回执。含分支项目在大纲关闭时明示「分支未包含在正文中」
 * （issue #361，注记同时写入导出文件头），默认导出路径不静默。
 * 预览、复制与下载消费同一全文。Esc / 点击遮罩关闭。
 * 文件保存对话框随后续 Tauri 集成升级。
 */
export function ExportDialog({
  projectName,
  model,
  onClose,
}: ExportDialogProps) {
  const [showOutline, setShowOutline] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  useExportModalKeyboard(dialogRef, onClose)
  const { copyAll, copied, resetCopied, download } = useScriptExportActions(
    showOutline ? model.outline : model.plain,
    `${projectName}-剧本`,
  )

  return (
    <div className="pw-overlay" onPointerDown={onClose}>
      {/* 原生 dialog 承载对话框语义（S6819）；非模态 open 标记 + aria-modal，
          键盘模态边界（焦点移入/Tab 循环/关闭归还/Esc）见 useExportModalKeyboard */}
      <dialog
        ref={dialogRef}
        open
        className="pw-dialog"
        aria-label="导出剧本"
        aria-modal="true"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="pw-dialog-head">
          <b>导出剧本</b>
          <span className="pw-dialog-file">{projectName}-剧本.md</span>
          <span className="pw-dialog-scope" title="本次导出的内容范围">
            本次导出：{model.scopeLine}
          </span>
          <span className="pw-sp" />
          <button
            type="button"
            className="pw-dialog-x"
            onClick={onClose}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <pre className="pw-export-pre">
          {showOutline ? model.outline : model.plain}
        </pre>
        <ExportDialogFoot
          showOutline={showOutline}
          onToggleOutline={(checked) => {
            setShowOutline(checked)
            resetCopied()
          }}
          hint={bodyHint(
            showOutline,
            model.hasNarrative,
            model.summary.hasOutline,
            model.summary.branches,
          )}
          copied={copied}
          copyAll={copyAll}
          download={download}
        />
      </dialog>
    </div>
  )
}
