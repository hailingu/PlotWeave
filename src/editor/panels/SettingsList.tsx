import type { DragEvent as ReactDragEvent } from 'react'
import { PW_ENTITY_MIME, type EntityDragPayload } from '../dragDrop'
import { EditableName } from '../nodes/settings/NodeSettingsPanel'
import type { DocumentEntity, ProjectSettings } from '../settings'
import type { SettingsActions } from './LeftPanel'

/**
 * 左栏设定集分段的内容视图（issue 56 自 LeftPanel 拆出：LeftPanel 的组件
 * 函数已超出 80 行上限，本次增量改为模块拆分直至合规）。三个桶：
 * 角色 / 地点（可拖拽建引用、行内改名、删除）与文档（长篇自由文本，
 * 点击打开编辑器弹窗）。增删改全部经 SettingsActions 走命令栈可撤销。
 */

/** 实体拖拽负载：kind + id + name（dragDrop.ts 的 MIME 契约）。 */
function entityPayload(e: ReactDragEvent, payload: EntityDragPayload): void {
  e.dataTransfer.setData(PW_ENTITY_MIME, JSON.stringify(payload))
  e.dataTransfer.effectAllowed = 'copy'
}

function CharacterRow({
  settings,
  actions,
}: {
  readonly settings: ProjectSettings
  readonly actions: SettingsActions
}) {
  return (
    <>
      <div className="pw-settings-group">角色</div>
      {settings.characters.map((c) => (
        <div
          key={c.id}
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
      ))}
      <button type="button" className="pw-settings-add" onClick={actions.addCharacter}>
        ＋ 新增角色
      </button>
    </>
  )
}

function LocationRow({
  settings,
  actions,
}: {
  readonly settings: ProjectSettings
  readonly actions: SettingsActions
}) {
  return (
    <>
      <div className="pw-settings-group">地点</div>
      {settings.locations.map((l) => (
        <div
          key={l.id}
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
      ))}
      <button type="button" className="pw-settings-add" onClick={actions.addLocation}>
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
      <button type="button" className="pw-settings-add" onClick={actions.addDocument}>
        ＋ 新增文档
      </button>
    </>
  )
}

/** 设定集分段内容：角色 / 地点 / 文档三桶（issue 56 增文档）。 */
export default function SettingsList({
  settings,
  actions,
  onOpenDocument,
}: {
  readonly settings: ProjectSettings
  readonly actions: SettingsActions
  readonly onOpenDocument: (id: string) => void
}) {
  return (
    // 原生 section + aria-label（隐式 region，S6819 同 LeftPanel 大纲段）
    <section className="pw-settings" aria-label="设定集">
      <CharacterRow settings={settings} actions={actions} />
      <LocationRow settings={settings} actions={actions} />
      <DocumentRow
        documents={settings.documents ?? []}
        actions={actions}
        onOpenDocument={onOpenDocument}
      />
    </section>
  )
}
