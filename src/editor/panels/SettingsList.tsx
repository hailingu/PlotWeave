import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react'
import { PW_ENTITY_MIME, type EntityDragPayload } from '../dragDrop'
import { EditableName } from '../nodes/settings/NodeSettingsPanel'
import SettingsDetailForm from './SettingsDetailForm'
import type { DocumentEntity, ProjectSettings } from '../settings'
import type { SettingsActions } from './LeftPanel'

/**
 * 左栏设定集分段的内容视图（issue 56 自 LeftPanel 拆出：LeftPanel 的组件
 * 函数已超出 80 行上限，本次增量改为模块拆分直至合规）。三个桶：
 * 角色 / 地点（可拖拽建引用、行内改名、删除）与文档（长篇自由文本，
 * 点击打开编辑器弹窗）。增删改全部经 SettingsActions 走命令栈可撤销。
 * 人工详情编辑（issue 95）：条目行折叠钮展开侧栏内详情表单（名称 +
 * 小传/备注），保存一次派发 updateCharacter/updateLocation；空项目显示
 * 新增引导，新增后 diff 出新实体自动展开并聚焦首个可编辑字段。展开
 * 标识按 kind + id 成对记录——角色/地点是两个独立 id 空间，字符串可能
 * 跨桶同名，裸 id 无法解析归属（数据模型 §8.1，PR #97 评审）。
 */

/** 实体拖拽负载：kind + id + name（dragDrop.ts 的 MIME 契约）。 */
function entityPayload(e: ReactDragEvent, payload: EntityDragPayload): void {
  e.dataTransfer.setData(PW_ENTITY_MIME, JSON.stringify(payload))
  e.dataTransfer.effectAllowed = 'copy'
}

/** 详情表单的展开标识：kind + id 显式成对（同 relatedIds 的成对契约）。 */
type ExpandedEntry = { kind: 'character' | 'location'; id: string }

/** 该条目的详情表单是否展开：kind 与 id 必须同时匹配。 */
function isOpen(
  expanded: ExpandedEntry | null,
  kind: 'character' | 'location',
  id: string,
): boolean {
  return expanded?.kind === kind && expanded.id === id
}

/** 条目行折叠钮（issue 95）：aria-expanded 语义的展开控件。 */
function DetailToggle({
  label,
  expanded,
  onToggle,
}: {
  readonly label: string
  readonly expanded: boolean
  readonly onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="pw-settings-caret"
      aria-label={label}
      aria-expanded={expanded}
      title={expanded ? '收起详情编辑' : '展开详情编辑（名称与小传/备注）'}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    >
      <span aria-hidden>{expanded ? '▾' : '▸'}</span>
    </button>
  )
}

function CharacterRow({
  settings,
  actions,
  expanded,
  onToggle,
  onAdd,
}: {
  readonly settings: ProjectSettings
  readonly actions: SettingsActions
  readonly expanded: ExpandedEntry | null
  readonly onToggle: (kind: 'character' | 'location', id: string) => void
  readonly onAdd: () => void
}) {
  return (
    <>
      <div className="pw-settings-group">角色</div>
      {settings.characters.map((c) => (
        <Fragment key={c.id}>
          <div
            className="pw-settings-item pw-draggable"
            draggable
            title="拖到画布节点建立引用，或拖到空白处新建场景"
            onDragStart={(e: ReactDragEvent) =>
              entityPayload(e, { kind: 'character', id: c.id, name: c.name })
            }
          >
            <span className="pw-av pw-av-sm" style={{ background: c.gradient }}>
              {c.name.charAt(0)}
            </span>
            <span className="pw-settings-item-body">
              <EditableName
                value={c.name}
                ariaLabel={`角色名 ${c.name}`}
                onChange={(name) => actions.renameCharacter(c.id, name)}
              />
            </span>
            <DetailToggle
              label={`编辑角色 ${c.name}`}
              expanded={isOpen(expanded, 'character', c.id)}
              onToggle={() => onToggle('character', c.id)}
            />
            <button
              type="button"
              className="pw-settings-x"
              aria-label={`删除角色 ${c.name}`}
              title="删除角色（节点引用将标记失效）"
              onClick={() => actions.deleteCharacter(c.id)}
            >
              ✕
            </button>
          </div>
          {isOpen(expanded, 'character', c.id) && (
            <SettingsDetailForm
              nameField="角色名称"
              descField="角色小传"
              baselineName={c.name}
              description={c.bio ?? ''}
              onSave={(name, bio) => {
                actions.updateCharacter(c.id, { name, bio })
                onToggle('character', c.id)
              }}
              onClose={() => onToggle('character', c.id)}
            />
          )}
        </Fragment>
      ))}
      <button type="button" className="pw-settings-add" onClick={onAdd}>
        ＋ 新增角色
      </button>
    </>
  )
}

function LocationRow({
  settings,
  actions,
  expanded,
  onToggle,
  onAdd,
}: {
  readonly settings: ProjectSettings
  readonly actions: SettingsActions
  readonly expanded: ExpandedEntry | null
  readonly onToggle: (kind: 'character' | 'location', id: string) => void
  readonly onAdd: () => void
}) {
  return (
    <>
      <div className="pw-settings-group">地点</div>
      {settings.locations.map((l) => (
        <Fragment key={l.id}>
          <div
            className="pw-settings-item pw-draggable"
            draggable
            title="拖到索引卡设置地点，或拖到空白处新建场景"
            onDragStart={(e: ReactDragEvent) =>
              entityPayload(e, { kind: 'location', id: l.id, name: l.name })
            }
          >
            <span className="pw-settings-item-body">
              <EditableName
                value={l.name}
                ariaLabel={`地点名 ${l.name}`}
                onChange={(name) => actions.renameLocation(l.id, name)}
              />
            </span>
            <DetailToggle
              label={`编辑地点 ${l.name}`}
              expanded={isOpen(expanded, 'location', l.id)}
              onToggle={() => onToggle('location', l.id)}
            />
            <button
              type="button"
              className="pw-settings-x"
              aria-label={`删除地点 ${l.name}`}
              title="删除地点（节点引用将标记失效）"
              onClick={() => actions.deleteLocation(l.id)}
            >
              ✕
            </button>
          </div>
          {isOpen(expanded, 'location', l.id) && (
            <SettingsDetailForm
              nameField="地点名称"
              descField="地点备注"
              baselineName={l.name}
              description={l.note ?? ''}
              onSave={(name, note) => {
                actions.updateLocation(l.id, { name, note })
                onToggle('location', l.id)
              }}
              onClose={() => onToggle('location', l.id)}
            />
          )}
        </Fragment>
      ))}
      <button type="button" className="pw-settings-add" onClick={onAdd}>
        ＋ 新增地点
      </button>
    </>
  )
}

function DocumentRow({
  documents,
  actions,
  onOpenDocument,
}: {
  readonly documents: DocumentEntity[]
  readonly actions: SettingsActions
  readonly onOpenDocument: (id: string) => void
}) {
  return (
    <>
      <div className="pw-settings-group">文档</div>
      {documents.map((d) => (
        <div key={d.id} className="pw-settings-item">
          <button
            type="button"
            className="pw-doc-open"
            aria-label={`打开文档 ${d.title}`}
            title="点击查看与编辑（长篇文本）"
            onClick={() => onOpenDocument(d.id)}
          >
            <span aria-hidden>📄</span>
            <span className="pw-doc-title">{d.title}</span>
          </button>
          <button
            type="button"
            className="pw-settings-x"
            aria-label={`删除文档 ${d.title}`}
            title="删除文档"
            onClick={() => actions.deleteDocument(d.id)}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="pw-settings-add"
        onClick={actions.addDocument}
      >
        ＋ 新增文档
      </button>
    </>
  )
}

/** 设定集分段内容：角色 / 地点 / 文档三桶（issue 56 增文档，issue 95 增详情编辑）。 */
export default function SettingsList({
  settings,
  actions,
  onOpenDocument,
}: {
  readonly settings: ProjectSettings
  readonly actions: SettingsActions
  readonly onOpenDocument: (id: string) => void
}) {
  const { characters, locations } = settings
  const [expanded, setExpanded] = useState<ExpandedEntry | null>(null)
  /** 新增待认领：点击新增时记录既有 id，settings 出现新 id 即自动展开。 */
  const pendingAdd = useRef<{
    kind: 'character' | 'location'
    before: Set<string>
  } | null>(null)

  // 新增自动展开（issue 95）：新实体出现即展开其详情表单；
  // 表单名称字段 autoFocus 落焦，即「聚焦首个可编辑字段」。
  useEffect(() => {
    const pending = pendingAdd.current
    if (!pending) return
    const bucket = pending.kind === 'character' ? characters : locations
    const added = bucket.find((e) => !pending.before.has(e.id))
    if (!added) return
    pendingAdd.current = null
    setExpanded({ kind: pending.kind, id: added.id })
  }, [characters, locations])

  const handleAdd = (kind: 'character' | 'location', add: () => void) => {
    pendingAdd.current = {
      kind,
      before: new Set(
        (kind === 'character' ? characters : locations).map((e) => e.id),
      ),
    }
    add()
  }
  const toggle = (kind: 'character' | 'location', id: string) =>
    setExpanded((cur) => (isOpen(cur, kind, id) ? null : { kind, id }))
  const empty =
    characters.length === 0 &&
    locations.length === 0 &&
    (settings.documents ?? []).length === 0

  return (
    // 原生 section + aria-label（隐式 region，S6819 同 LeftPanel 大纲段）
    <section className="pw-settings" aria-label="设定集">
      {empty && (
        <p className="pw-settings-empty">
          暂无设定条目：从下方新增角色 / 地点 / 文档开始；点击条目的 ▸
          展开钮即可编辑名称与小传、备注。
        </p>
      )}
      <CharacterRow
        settings={settings}
        actions={actions}
        expanded={expanded}
        onToggle={toggle}
        onAdd={() => handleAdd('character', actions.addCharacter)}
      />
      <LocationRow
        settings={settings}
        actions={actions}
        expanded={expanded}
        onToggle={toggle}
        onAdd={() => handleAdd('location', actions.addLocation)}
      />
      <DocumentRow
        documents={settings.documents ?? []}
        actions={actions}
        onOpenDocument={onOpenDocument}
      />
    </section>
  )
}
