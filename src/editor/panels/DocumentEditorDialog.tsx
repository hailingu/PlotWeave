import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DocumentEntity, ProjectSettings } from '../settings'

/**
 * 设定文档查看/编辑弹窗（issue 56，docs/ui-design.md §5）：长篇自由文本
 * （人物小传/世界观/术语表）的阅读与人工编辑入口。标题/正文整体保存，
 * 关联角色/地点经 chips 切换（relatedIds：kind + id 显式成对，§6）。
 * 「保存」一次派发一条 updateDocument 命令入栈可撤销；Esc / 遮罩 /
 * 关闭按钮放弃编辑（编辑即命令的批量变体：单次确认生成单条命令）。
 * 弹窗是一次模态编辑会话（issue #126）：打开期间全局撤销/重做/删除快捷键
 * 挂起（useEditorHotkeys，输入框内保持原生文本撤销）；底层文档若仍经残余
 * 路径变化，未编辑草稿跟随刷新、已编辑草稿保留（useDocumentDraft），文档
 * 删除则弹窗随 id 解析失败由宿主卸载——保存永不把已撤销的旧草稿写回。
 * 经 portal 渲染到 document.body：宿主 .pw-panel 同时带 overflow:hidden
 * 与 backdrop-filter，会为 fixed 后代建立包含块并裁剪到窄侧栏内
 * （PR #86 评审），弹窗必须落在面板裁剪上下文之外。
 */

/** 文档编辑保存的补丁形状（与 useSettingsActions 的 updateDocument 一致）。 */
export interface DocumentSavePatch {
  title?: string
  body?: string
  relatedIds?: DocumentEntity['relatedIds']
}

function RelatedChip({
  kind,
  id,
  name,
  active,
  onToggle,
}: {
  readonly kind: 'character' | 'location'
  readonly id: string
  readonly name: string
  readonly active: boolean
  readonly onToggle: (kind: 'character' | 'location', id: string) => void
}) {
  return (
    <button
      type="button"
      className="pw-doc-chip"
      aria-label={`关联${kind === 'character' ? '角色' : '地点'} ${name}`}
      aria-pressed={active}
      title={active ? '点击取消关联' : '点击建立关联'}
      onClick={() => onToggle(kind, id)}
    >
      {active ? '✓ ' : ''}
      {name}
    </button>
  )
}

/** 关联条目选择区：角色与地点两组 chips（settings 全量，非激活可选）。 */
function RelatedPicker({
  settings,
  relatedIds,
  onToggle,
}: {
  readonly settings: ProjectSettings
  readonly relatedIds: DocumentEntity['relatedIds']
  readonly onToggle: (kind: 'character' | 'location', id: string) => void
}) {
  const isActive = (kind: 'character' | 'location', id: string) =>
    relatedIds.some((r) => r.kind === kind && r.id === id)
  return (
    <>
      <span className="pw-doc-editor-label">关联设定条目</span>
      <div className="pw-doc-chips">
        {settings.characters.map((c) => (
          <RelatedChip
            key={c.id}
            kind="character"
            id={c.id}
            name={c.name}
            active={isActive('character', c.id)}
            onToggle={onToggle}
          />
        ))}
        {settings.locations.map((l) => (
          <RelatedChip
            key={l.id}
            kind="location"
            id={l.id}
            name={l.name}
            active={isActive('location', l.id)}
            onToggle={onToggle}
          />
        ))}
      </div>
    </>
  )
}

/** 标题/正文字段组（文档编辑器拆出，函数行数上限）。 */
function TitleBodyFields({
  title,
  body,
  onTitle,
  onBody,
}: {
  readonly title: string
  readonly body: string
  readonly onTitle: (v: string) => void
  readonly onBody: (v: string) => void
}) {
  return (
    <>
      <label className="pw-doc-editor-label" htmlFor="pw-doc-title-input">
        文档标题
      </label>
      <input
        id="pw-doc-title-input"
        className="pw-doc-title-input"
        value={title}
        onChange={(e) => onTitle(e.target.value)}
      />
      <label className="pw-doc-editor-label" htmlFor="pw-doc-body-input">
        文档正文
      </label>
      <textarea
        id="pw-doc-body-input"
        className="pw-doc-body"
        value={body}
        onChange={(e) => onBody(e.target.value)}
      />
    </>
  )
}

/** 对话框头部（DocumentEditorDialog 拆分，issue #99）：标题 + 落盘说明 + 关闭。 */
function DocumentDialogHead({ onClose }: { readonly onClose: () => void }) {
  return (
    <div className="pw-dialog-head">
      <b>📄 编辑设定文档</b>
      <span className="pw-dialog-file">保存后随项目自动落盘</span>
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
 * 文档编辑草稿（issue #126）：挂载时以底层文档为基线；底层文档经 props
 * 更新且草稿未被编辑时跟随刷新——保存永不写回陈旧字段；一旦编辑即固定
 * 用户输入，不以 props 同步覆盖未保存内容。文档删除由宿主按 id 解析失败
 * 卸载弹窗，不在草稿层处理。
 */
function useDocumentDraft(doc: DocumentEntity) {
  const [title, setTitle] = useState(doc.title)
  const [body, setBody] = useState(doc.body)
  const [relatedIds, setRelatedIds] = useState(doc.relatedIds)
  const [edited, setEdited] = useState(false)
  useEffect(() => {
    if (edited) return
    setTitle(doc.title)
    setBody(doc.body)
    setRelatedIds(doc.relatedIds)
  }, [doc, edited])
  const editTitle = (v: string) => {
    setEdited(true)
    setTitle(v)
  }
  const editBody = (v: string) => {
    setEdited(true)
    setBody(v)
  }
  const toggleRelated = (kind: 'character' | 'location', id: string) => {
    setEdited(true)
    setRelatedIds((prev) =>
      prev.some((r) => r.kind === kind && r.id === id)
        ? prev.filter((r) => !(r.kind === kind && r.id === id))
        : [...prev, { kind, id }],
    )
  }
  return { title, body, relatedIds, editTitle, editBody, toggleRelated }
}

/** 设定文档查看/编辑弹窗（语义见模块头，issue 56）：模态会话期间全局
 * 快捷键挂起，「保存」一次派发一条可撤销命令。 */
export function DocumentEditorDialog({
  doc,
  settings,
  onSave,
  onClose,
}: {
  readonly doc: DocumentEntity
  readonly settings: ProjectSettings
  readonly onSave: (id: string, patch: DocumentSavePatch) => void
  readonly onClose: () => void
}) {
  const draft = useDocumentDraft(doc)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = () => {
    onSave(doc.id, {
      title: draft.title,
      body: draft.body,
      relatedIds: draft.relatedIds,
    })
    onClose()
  }

  return createPortal(
    <div className="pw-overlay" onPointerDown={onClose}>
      {/* 原生 dialog 承载对话框语义（S6819，同 ExportDialog）；Esc/遮罩关闭 */}
      <dialog
        open
        className="pw-dialog pw-doc-editor"
        aria-label="编辑设定文档"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <DocumentDialogHead onClose={onClose} />
        <div className="pw-doc-editor-body">
          <TitleBodyFields
            title={draft.title}
            body={draft.body}
            onTitle={draft.editTitle}
            onBody={draft.editBody}
          />
          <RelatedPicker
            settings={settings}
            relatedIds={draft.relatedIds}
            onToggle={draft.toggleRelated}
          />
        </div>
        <div className="pw-dialog-foot">
          <span className="pw-dialog-hint">
            标题为空时无法保存；编辑中全局撤销挂起；Esc 关闭放弃改动
          </span>
          <span className="pw-sp" />
          <button
            type="button"
            className="pw-dialog-btn pw-dialog-btn-primary"
            disabled={draft.title.trim() === ''}
            onClick={save}
          >
            保存
          </button>
        </div>
      </dialog>
    </div>,
    document.body,
  )
}
