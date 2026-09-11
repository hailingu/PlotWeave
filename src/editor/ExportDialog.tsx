import { useEffect, useRef, useState } from 'react'
import type { ScriptExportModel } from './exportScript'

interface ExportDialogProps {
  /** 项目名，用于标题与默认文件名。 */
  readonly projectName: string
  /** 一次生成结果：正文与可选大纲两个全文 + 导出范围概要。 */
  readonly model: ScriptExportModel
  readonly onClose: () => void
}

/** 开关态下的正文提示：无正文时引导开启大纲（issue #48）。 */
function bodyHint(showOutline: boolean, hasNarrative: boolean): string {
  if (showOutline) return '正文 = 场景 + 对白；创作大纲与分镜卡为附录'
  if (!hasNarrative) return '正文为空（尚无场景与对白）；开启「创作大纲」可查看节奏与分支'
  return '正文 = 场景 + 对白；分镜卡见附录'
}

/**
 * 剧本导出对话框（docs/ui-design.md §3.3 导出、§3.5 剧本导出）。
 * 预览生成的正文（场景 + 对白，节拍/分支不进正文）与附录；
 * 「创作大纲」开关默认关闭，开启后在文末并入大纲附录（节奏名称/基调、分支问句
 * 与选项去向）——开关只切换同一生成结果的文本，不改动画布或项目实体。
 * 预览、复制与下载消费同一 text。Esc / 点击遮罩关闭。
 * 文件保存对话框随后续 Tauri 集成升级。
 */
export default function ExportDialog({ projectName, model, onClose }: ExportDialogProps) {
  const [copied, setCopied] = useState(false)
  const [showOutline, setShowOutline] = useState(false)
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

  const text = showOutline ? model.outline : model.plain

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
          <span className="pw-dialog-scope" title="本次导出的内容范围">
            本次导出：{model.scopeLine}
          </span>
          <span className="pw-sp" />
          <button type="button" className="pw-dialog-x" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <pre className="pw-export-pre">{text}</pre>
        <div className="pw-dialog-foot">
          <label className="pw-export-toggle">
            <input
              type="checkbox"
              checked={showOutline}
              onChange={(e) => setShowOutline(e.target.checked)}
            />
            <span>创作大纲（节奏与分支）</span>
          </label>
          <span className="pw-dialog-hint">{bodyHint(showOutline, model.hasNarrative)}</span>
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
