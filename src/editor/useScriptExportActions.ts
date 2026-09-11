import { useCallback, useEffect, useRef, useState } from 'react'

/** 复制成功态的展示时长（按钮回到「复制全文」）。 */
const COPIED_HOLD_MS = 1600

/** 剪贴板 API 的等待上限：部分 WebView 无权限时会挂起而不 reject。 */
const CLIPBOARD_TIMEOUT_MS = 800

/** 无剪贴板权限时全选预览文本，供用户手动复制。 */
function selectPreviewText(): void {
  const sel = window.getSelection()
  const pre = document.querySelector('.pw-export-pre')
  if (!sel || !pre) return
  const range = document.createRange()
  range.selectNodeContents(pre)
  sel.removeAllRanges()
  sel.addRange(range)
}

export interface ScriptExportActions {
  /** 复制当前全文；成功则按钮进入「✓ 已复制」态并限时恢复。 */
  copyAll: () => Promise<void>
  /** 复制成功态是否仍在展示。 */
  copied: boolean
  /**
   * 清除复制成功态。导出文本随大纲开关切换，上一变体的已复制回执不能
   * 继续显示，否则会让人误以为新变体也已在剪贴板（review #81）。
   */
  resetCopied: () => void
  /** 下载当前全文为 .md 文件。 */
  download: () => void
}

/**
 * 导出对话框的复制与下载交互（docs/ui-design.md §3.3 导出）：
 * 与渲染分离，让对话框组件专注布局；两个动作都消费调用时传入的全文，
 * 因此切换大纲开关后不再有指向上一变体的回执。
 */
export function useScriptExportActions(text: string, fileName: string): ScriptExportActions {
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearCopyTimer = useCallback(() => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = null
  }, [])

  const resetCopied = useCallback(() => {
    clearCopyTimer()
    setCopied(false)
  }, [clearCopyTimer])

  // 卸载时清掉未到期的恢复计时，避免对已卸载组件 setState
  useEffect(() => clearCopyTimer, [clearCopyTimer])

  const copyAll = useCallback(async () => {
    const written = await Promise.race([
      navigator.clipboard.writeText(text).then(() => true).catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CLIPBOARD_TIMEOUT_MS)),
    ])
    if (!written) {
      selectPreviewText()
      return
    }
    setCopied(true)
    clearCopyTimer()
    copyTimer.current = setTimeout(() => setCopied(false), COPIED_HOLD_MS)
  }, [clearCopyTimer, text])

  const download = useCallback(() => {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${fileName}.md`
    a.click()
    URL.revokeObjectURL(url)
  }, [fileName, text])

  return { copyAll, copied, resetCopied, download }
}
