import { useEffect, useRef, useState } from 'react'

interface ExportDialogProps {
  /** 项目名，用于标题与默认文件名。 */
  readonly projectName: string
  /** 已生成的剧本 Markdown 全文。 */
  readonly text: string
  readonly onClose: () => void
}

/**
 * 剧本导出对话框（docs/ui-design.md §3.3 导出、§3.5 剧本导出）。
 * 预览生成的正文（场景 + 对白，节拍/分支不出现）与分镜附录；
 * 支持复制全文与下载 .md 文件。Esc / 点击遮罩关闭。
 * 文件保存对话框随后续 Tauri 集成升级。
 */
export default function ExportDialog({ projectName, text, onClose }: ExportDialogProps) {
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [onClose])

  const copyAll = async () => {
    // 无剪贴板权限的环境（部分 WebView）clipboard API 会挂起，限时回退到全选预览
    const written = await Promise.race([
      navigator.clipboard.writeText(text).then(() => true).catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 800)),
    ])
    if (written) {
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1600)
    } else {
      const sel = window.getSelection()
      const pre = document.querySelector('.pw-export-pre')
      if (sel && pre) {
        const range = document.createRange()
        range.selectNodeContents(pre)
        sel.removeAllRanges()
        sel.addRange(range)
      }
    }
  }

  const download = () => {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${projectName}-剧本.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="pw-overlay" onPointerDown={onClose}>
      {/* 原生 dialog 承载对话框语义（S6819）；非模态，Esc/遮罩关闭为手动处理 */}
      <dialog
        open
        className="pw-dialog"
        aria-label="导出剧本"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="pw-dialog-head">
          <b>导出剧本</b>
          <span className="pw-dialog-file">{projectName}-剧本.md</span>
          <span className="pw-sp" />
          <button type="button" className="pw-dialog-x" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <pre className="pw-export-pre">{text}</pre>
        <div className="pw-dialog-foot">
          <span className="pw-dialog-hint">正文 = 场景 + 对白；分镜卡见附录</span>
          <span className="pw-sp" />
          <button type="button" className="pw-dialog-btn" onClick={copyAll}>
            {copied ? '✓ 已复制' : '复制全文'}
          </button>
          <button type="button" className="pw-dialog-btn pw-dialog-btn-primary" onClick={download}>
            下载 .md
          </button>
        </div>
      </dialog>
    </div>
  )
}
