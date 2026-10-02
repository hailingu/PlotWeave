import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { errorBannerMessage } from './errorBannerMessage'

/** 用户可选的剧本交付格式，同时决定文件后缀与媒体类型。 */
export type ScriptExportFormat = 'md' | 'json'

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

/** 剧本导出对话框的动作族（复制/回执/关闭失效）；请求归属与回执失效
 * 语义见 useScriptExportActions。 */
export interface ScriptExportActions {
  /** 复制当前全文；成功则按钮进入「✓ 已复制」态并限时恢复。 */
  copyAll: () => Promise<void>
  /** 复制成功态是否仍在展示。 */
  copied: boolean
  /**
   * 清除复制成功态并使进行中的请求失效，避免上一变体的迟到结果
   * 更新当前回执或选区（review #81）。
   */
  resetCopied: () => void
  /** 下载当前全文为所选格式的文件。 */
  download: () => void
  /** 下载失败的可见诊断；新内容或再次下载清除。 */
  downloadError: string | null
}

/** 剪贴板缺失、同步拒绝或超时统一失败，调用方可全选当前预览供手动复制。 */
async function writeClipboard(text: string): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      navigator.clipboard.writeText(text).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), CLIPBOARD_TIMEOUT_MS)
      }),
    ])
  } catch {
    return false
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

/**
 * 导出对话框的复制与回执生命周期（docs/ui-design.md §3.3 导出）：
 * 与渲染分离，消费当前预览的全文；
 * 复制回执按请求代次归属；切换文本、重试或卸载后忽略旧请求结果。
 */
function useCopyAction(text: string) {
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyGeneration = useRef(0)

  const clearCopyTimer = useCallback(() => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = null
  }, [])

  const resetCopied = useCallback(() => {
    copyGeneration.current += 1
    clearCopyTimer()
    setCopied(false)
  }, [clearCopyTimer])

  // 提交新预览时同步失效旧请求；卸载后也不得选中新打开的对话框。
  useLayoutEffect(() => {
    resetCopied()
    return () => {
      copyGeneration.current += 1
      clearCopyTimer()
    }
  }, [text, resetCopied, clearCopyTimer])

  const copyAll = useCallback(async () => {
    resetCopied()
    const generation = copyGeneration.current
    const written = await writeClipboard(text)
    if (generation !== copyGeneration.current) return
    if (!written) {
      selectPreviewText()
      return
    }
    setCopied(true)
    clearCopyTimer()
    copyTimer.current = setTimeout(() => setCopied(false), COPIED_HOLD_MS)
  }, [clearCopyTimer, resetCopied, text])

  return { copyAll, copied, resetCopied }
}

/** 复制回执与文件下载共用当前预览；下载失败显示诊断，并在所有出口释放 URL。 */
export function useScriptExportActions(
  text: string,
  fileName: string,
  format: ScriptExportFormat,
): ScriptExportActions {
  const copy = useCopyAction(text)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  useLayoutEffect(() => setDownloadError(null), [text, format])
  const download = useCallback(() => {
    setDownloadError(null)
    let url: string | undefined
    try {
      const mime = format === 'json' ? 'application/json' : 'text/markdown'
      const blob = new Blob([text], { type: `${mime};charset=utf-8` })
      url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${fileName}.${format}`
      a.click()
    } catch (error) {
      setDownloadError(`下载失败：${errorBannerMessage(error)}`)
    } finally {
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [fileName, format, text])

  return { ...copy, download, downloadError }
}
