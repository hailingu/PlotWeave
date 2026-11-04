import { DialogFooter } from '../ui/DialogFooter'
import { useRef, useState } from 'react'
import { useModalKeyboard } from '../ui/useModalKeyboard'
import type { ScriptExportModel } from './exportScript'
import {
  useScriptExportActions,
  type ScriptExportFormat,
} from './useScriptExportActions'
import { ErrorBanner } from './ErrorBanner'

interface ExportDialogProps {
  /** 项目名，用于标题与默认文件名。 */
  readonly projectName: string
  /** 一次生成结果：正文与可选大纲两个全文 + 导出范围概要。 */
  readonly model: ScriptExportModel
  /** 当前会话按 ProjectDocument 契约生成的完整 JSON 文本。 */
  readonly json: string
  readonly onClose: () => void
}

/** 导出对话框脚部：选择交付格式、Markdown 大纲开关与复制/下载操作。 */
function ExportDialogFoot({
  format,
  onFormat,
  showOutline,
  onToggleOutline,
  hint,
  copied,
  copyAll,
  download,
}: {
  readonly format: ScriptExportFormat
  readonly onFormat: (format: ScriptExportFormat) => void
  readonly showOutline: boolean
  readonly onToggleOutline: (checked: boolean) => void
  readonly hint: string
  readonly copied: boolean
  readonly copyAll: () => void
  readonly download: () => void
}) {
  return (
    <DialogFooter
      className="pw-export-foot"
      secondary={{ label: copied ? '✓ 已复制' : '复制全文', onClick: copyAll }}
      primary={{ label: `下载 .${format}`, onClick: download }}
    >
      <label className="pw-export-toggle">
        <span>导出格式</span>
        <select
          className="pw-dialog-btn"
          value={format}
          onChange={(e) => onFormat(e.target.value === 'json' ? 'json' : 'md')}
        >
          <option value="md">Markdown</option>
          <option value="json">JSON</option>
        </select>
      </label>
      {format === 'md' && (
        <label className="pw-export-toggle">
          <input
            type="checkbox"
            checked={showOutline}
            onChange={(e) => onToggleOutline(e.target.checked)}
          />
          <span>创作大纲（节奏与分支）</span>
        </label>
      )}
      <span className="pw-dialog-hint">{hint}</span>
    </DialogFooter>
  )
}

/** 根据实际内容与开关态提示：仅有节拍/分支时引导开启大纲，无故事内容则说明
 * 空态；既有叙事又有分支且大纲关闭时明示分支未包含并引导并入（issue #361，
 * 默认导出路径不允许静默丢弃分支结构）。 */
function bodyHint(
  format: ScriptExportFormat,
  showOutline: boolean,
  hasNarrative: boolean,
  hasOutline: boolean,
  branches: number,
): string {
  if (format === 'json')
    return '包含全部节点、连线、设定与资产索引；不含媒体文件和 AI 会话'
  if (!hasNarrative && !hasOutline) return '暂无可导出的场景、对白、节奏或分支'
  if (showOutline) return '正文 = 场景 + 对白；创作大纲与分镜卡为附录'
  if (!hasNarrative)
    return '正文为空（尚无场景与对白）；开启「创作大纲」可查看节奏与分支'
  if (branches > 0)
    return `正文 = 场景 + 对白；${branches} 处分支未包含在正文中，开启「创作大纲」附录可并入`
  return '正文 = 场景 + 对白；分镜卡见附录'
}

/** 标题与交付文件名始终反映当前格式，关闭按钮作为首个键盘焦点。 */
function ExportDialogHead({
  projectName,
  format,
  scopeLine,
  onClose,
}: {
  readonly projectName: string
  readonly format: ScriptExportFormat
  readonly scopeLine: string
  readonly onClose: () => void
}) {
  return (
    <div className="pw-dialog-head">
      <b>导出剧本</b>
      <span className="pw-dialog-file">
        {projectName}-剧本.{format}
      </span>
      <span className="pw-dialog-scope" title="本次导出的内容范围">
        本次导出：
        {format === 'json' ? '完整画布 · 设定集 · 资产索引' : scopeLine}
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
  )
}

/**
 * 剧本导出对话框（docs/ui-design.md §3.3 导出、§3.5 剧本导出）。
 * 预览生成的正文（场景 + 对白，节拍/分支不进正文）与附录；
 * 「创作大纲」开关默认关闭，开启后在文末并入大纲附录（节奏名称/基调、分支问句
 * 与选项去向）——开关只切换同一生成结果的文本，不改动画布或项目实体，并清除
 * 上一变体的复制回执。含分支项目在大纲关闭时明示「分支未包含在正文中」
 * （issue #361，注记同时写入导出文件头），默认导出路径不静默。
 * 预览、复制与下载消费同一全文。Esc / 点击遮罩关闭。
 * JSON 格式导出完整项目文档；大纲开关只影响 Markdown，切换格式清复制回执。
 * 文件保存对话框随后续 Tauri 集成升级。
 */
export function ExportDialog({
  projectName,
  model,
  json,
  onClose,
}: ExportDialogProps) {
  const [showOutline, setShowOutline] = useState(false)
  const [format, setFormat] = useState<ScriptExportFormat>('md')
  const dialogRef = useRef<HTMLDialogElement>(null)
  useModalKeyboard(dialogRef, onClose)
  const markdown = showOutline ? model.outline : model.plain
  const text = format === 'json' ? json : markdown
  const { copyAll, copied, resetCopied, download, downloadError } =
    useScriptExportActions(text, `${projectName}-剧本`, format)

  return (
    <div className="pw-overlay" onPointerDown={onClose}>
      {/* 原生 dialog 承载对话框语义（S6819）；非模态 open 标记 + aria-modal，
          键盘模态边界（焦点移入/Tab 循环/关闭归还/Esc）见 useModalKeyboard */}
      <dialog
        ref={dialogRef}
        open
        className="pw-dialog"
        aria-label="导出剧本"
        aria-modal="true"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <ExportDialogHead
          projectName={projectName}
          format={format}
          scopeLine={model.scopeLine}
          onClose={onClose}
        />
        <pre className="pw-export-pre">{text}</pre>
        {downloadError && <ErrorBanner message={downloadError} />}
        <ExportDialogFoot
          format={format}
          onFormat={(next) => {
            setFormat(next)
            resetCopied()
          }}
          showOutline={showOutline}
          onToggleOutline={(checked) => {
            setShowOutline(checked)
            resetCopied()
          }}
          hint={bodyHint(
            format,
            showOutline,
            model.hasNarrative,
            model.summary.hasOutline,
            model.summary.branches,
          )}
          copied={copied}
          copyAll={() => void copyAll()}
          download={download}
        />
      </dialog>
    </div>
  )
}
