import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import type { Edge } from '@xyflow/react'
import SegmentedControl from './SegmentedControl'
import PanelResizer from './PanelResizer'
import { ASSET_CATEGORIES } from '../sampleData'
import { buildOutlineGroups, type OutlineDropTarget } from '../outline'
import { PW_ENTITY_MIME, type EntityDragPayload } from '../dragDrop'
import { EditableName } from '../nodes/settings/NodeSettingsPanel'
import type { ProjectSettings } from '../settings'
import type { CanvasNode } from '../nodes/types'

/** 大纲行拖拽的自定义 MIME（与设定集实体拖拽 PW_ENTITY_MIME 区分）。 */
const OUTLINE_MIME = 'application/x-pw-outline'

/** 大纲行拖拽落点提示：行上半/下半插入线，或整组接收。 */
type DropHint =
  | { kind: 'row'; id: string; pos: 'before' | 'after' }
  | { kind: 'group'; episode: number | null }
  | null

/** 设定集条目编辑动作（§5：增/改名/删，走命令栈可撤销）。 */
export interface SettingsActions {
  addCharacter: () => void
  renameCharacter: (id: string, name: string) => void
  deleteCharacter: (id: string) => void
  addLocation: () => void
  renameLocation: (id: string, name: string) => void
  deleteLocation: (id: string) => void
}

/** 左栏分段（docs/ui-design.md §3.4）：大纲 = 故事脊线线性投影，设定集/资产 = 引用源。 */
type LeftTab = 'outline' | 'settings' | 'assets'

const TABS = [
  { value: 'outline' as const, label: '大纲' },
  { value: 'settings' as const, label: '设定集' },
  { value: 'assets' as const, label: '资产' },
]

interface LeftPanelProps {
  /** 面板展开状态：折叠时宽度动画到 0（弹簧），组件保持挂载以保留分段状态。 */
  open: boolean
  width: number
  onResize: (width: number) => void
  /** 画布节点，用于派生大纲行。 */
  nodes: CanvasNode[]
  /** 画布连线：下挂分镜的集归属随宿主场景派生（§7.2）。 */
  edges: Edge[]
  /** 大纲 ⇄ 画布联动（§3.5）：点击大纲行选中并居中该节点。 */
  onLocate?: (id: string) => void
  /** 画布当前选中节点 id：大纲行反向高亮并滚动到可见。 */
  selectedId?: string
  /** 项目设定集（§5）：设定集分段的数据源。 */
  settings: ProjectSettings
  /** 设定集条目编辑动作（§5）。 */
  settingsActions: SettingsActions
  /** 集 = 编号 + 行内标题（§3.5）。 */
  episodeTitles: Record<number, string>
  /** 当前聚焦的集；null = 无聚焦。 */
  focusedEpisode: number | null
  /** 点击集行：该集提亮、其余退后；再点取消。 */
  onFocusEpisode?: (episode: number | null) => void
  /** 集标题行内改名（编辑即命令）。 */
  onRenameEpisode?: (episode: number, title: string) => void
  /** 大纲拖拽落点（§3.5：重排 sequence 边 / 跨组改集归属）。 */
  onOutlineDrop?: (draggedId: string, target: OutlineDropTarget) => void
}

/**
 * 编辑器左栏（docs/ui-design.md §3.4/§3.5/§8.1）：
 * 「大纲 / 设定集 / 资产」三分段。半透明材质 + 内容下滚动 + 边缘渐隐，
 * 无 1px 硬分隔线；内缘挂拖拽调宽手柄。
 * 大纲按集分组（集 = 逻辑分类：点击集行画布聚焦，行内标题可编辑），
 * 与画布双向联动；大纲拖拽排序、资产拖拽引用随后续任务落地。
 */
export default function LeftPanel({
  open,
  width,
  onResize,
  nodes,
  edges,
  onLocate,
  selectedId,
  settings,
  settingsActions,
  episodeTitles,
  focusedEpisode,
  onFocusEpisode,
  onRenameEpisode,
  onOutlineDrop,
}: LeftPanelProps) {
  const [tab, setTab] = useState<LeftTab>('outline')
  const groups = useMemo(
    () => buildOutlineGroups(nodes, edges, episodeTitles),
    [nodes, edges, episodeTitles],
  )
  const outlineRef = useRef<HTMLDivElement>(null)
  const [dropHint, setDropHint] = useState<DropHint>(null)

  // level < 3 = 编剧侧四类（分镜随宿主场景，不参与拖拽排序）
  const readDragged = (e: ReactDragEvent): string | null => {
    const id = e.dataTransfer.getData(OUTLINE_MIME)
    return id !== '' ? id : null
  }
  const rowDragOver = (e: ReactDragEvent, row: { id: string; level: number }) => {
    if (row.level >= 3 || !onOutlineDrop) return
    if (!e.dataTransfer.types.includes(OUTLINE_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setDropHint({ kind: 'row', id: row.id, pos })
  }
  const rowDrop = (e: ReactDragEvent, row: { id: string; level: number }) => {
    const dragged = readDragged(e)
    setDropHint(null)
    if (!dragged || dragged === row.id || row.level >= 3 || !onOutlineDrop) return
    e.preventDefault()
    const pos = dropHint?.kind === 'row' && dropHint.id === row.id ? dropHint.pos : 'after'
    onOutlineDrop(dragged, { kind: 'row', anchorId: row.id, position: pos })
  }
  const groupDragOver = (e: ReactDragEvent, episode: number | null) => {
    if (!onOutlineDrop) return
    if (!e.dataTransfer.types.includes(OUTLINE_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropHint({ kind: 'group', episode })
  }
  const groupDrop = (e: ReactDragEvent, episode: number | null) => {
    const dragged = readDragged(e)
    setDropHint(null)
    if (!dragged || !onOutlineDrop) return
    e.preventDefault()
    onOutlineDrop(dragged, { kind: 'groupEnd', episode })
  }

  // 反向联动：画布选中变化时，大纲行滚动到可见（不抢横向滚动）。
  useEffect(() => {
    if (tab !== 'outline' || !selectedId) return
    outlineRef.current
      ?.querySelector('.pw-outline-on')
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedId, tab])

  return (
    <aside
      className={`pw-panel pw-panel-left${open ? '' : ' pw-panel-closed'}`}
      style={{ width: open ? width : 0 }}
      aria-hidden={!open}
    >
      <div className="pw-panel-inner" style={{ width }}>
        <div className="pw-panel-head">
          <SegmentedControl groupLabel="左栏分段" options={TABS} value={tab} onChange={setTab} />
        </div>
        <div className="pw-panel-scroll">
          {tab === 'outline' && (
            <div className="pw-outline" role="list" aria-label="故事大纲" ref={outlineRef}>
              {groups.map((group) => (
                <div key={group.episode ?? 'none'} className="pw-outline-group">
                  {group.episode === null ? (
                    <div
                      className={`pw-outline-ep static${dropHint?.kind === 'group' && dropHint.episode === null ? ' pw-drop-into' : ''}`}
                      onDragOver={(e) => groupDragOver(e, null)}
                      onDragLeave={() => setDropHint(null)}
                      onDrop={(e) => groupDrop(e, null)}
                    >
                      未分集
                    </div>
                  ) : (
                    <div
                      className={`pw-outline-ep${dropHint?.kind === 'group' && dropHint.episode === group.episode ? ' pw-drop-into' : ''}`}
                      onDragOver={(e) => groupDragOver(e, group.episode)}
                      onDragLeave={() => setDropHint(null)}
                      onDrop={(e) => groupDrop(e, group.episode)}
                    >
                      <button
                        type="button"
                        className={`pw-outline-ep-btn${focusedEpisode === group.episode ? ' on' : ''}`}
                        aria-pressed={focusedEpisode === group.episode}
                        title="点击聚焦该集，画布其余节点退后（再点取消）"
                        onClick={() => onFocusEpisode?.(group.episode!)}
                      >
                        第 {group.episode} 集
                      </button>
                      <EditableName
                        value={group.title}
                        ariaLabel={`第 ${group.episode} 集标题`}
                        onChange={(title) => onRenameEpisode?.(group.episode!, title)}
                      />
                      <span className="pw-sp" />
                      <span className="pw-outline-ep-count">{group.rows.length} 行</span>
                    </div>
                  )}
                  {group.rows.map((row) => {
                    const draggable = row.level < 3 && onOutlineDrop !== undefined
                    const hint =
                      dropHint?.kind === 'row' && dropHint.id === row.id ? dropHint.pos : null
                    return (
                      <button
                        key={row.id}
                        type="button"
                        className={[
                          'pw-outline-row',
                          row.id === selectedId ? ' pw-outline-on' : '',
                          hint === 'before' ? ' pw-drop-above' : '',
                          hint === 'after' ? ' pw-drop-below' : '',
                        ].join('')}
                        role="listitem"
                        data-level={row.level}
                        style={{ paddingLeft: 10 + row.level * 16 }}
                        draggable={draggable}
                        title={draggable ? '拖拽排序（重排剧情流）；点击定位到画布' : '点击定位到画布'}
                        onDragStart={(e) => {
                          e.dataTransfer.setData(OUTLINE_MIME, row.id)
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragEnd={() => setDropHint(null)}
                        onDragOver={(e) => rowDragOver(e, row)}
                        onDragLeave={() =>
                          setDropHint((h) => (h?.kind === 'row' && h.id === row.id ? null : h))
                        }
                        onDrop={(e) => rowDrop(e, row)}
                        onClick={() => onLocate?.(row.id)}
                      >
                        {row.label}
                        {row.beat?.pending && (
                          <span className="pw-beat-state pending" title="未被场景承载的节拍 = 节奏漏洞">
                            待兑现
                          </span>
                        )}
                        {row.beat && !row.beat.pending && (
                          <span className="pw-beat-state ok" title="承载场景（sequence 邻接派生）">
                            ✓ 兑现于 {row.beat.label}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
          {tab === 'settings' && (
            <div className="pw-settings">
              <div className="pw-settings-group">角色</div>
              {settings.characters.map((c) => (
                <div
                  key={c.id}
                  className="pw-settings-item pw-draggable"
                  draggable
                  title="拖到画布节点建立引用，或拖到空白处新建场景"
                  onDragStart={(e: ReactDragEvent) => {
                    e.dataTransfer.setData(
                      PW_ENTITY_MIME,
                      JSON.stringify({ kind: 'character', id: c.id, name: c.name } satisfies EntityDragPayload),
                    )
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                >
                  <span className="pw-av pw-av-sm" style={{ background: c.gradient }}>
                    {c.name.charAt(0)}
                  </span>
                  <span className="pw-settings-item-body">
                    <EditableName
                      value={c.name}
                      ariaLabel={`角色名 ${c.name}`}
                      onChange={(name) => settingsActions.renameCharacter(c.id, name)}
                    />
                  </span>
                  <button
                    type="button"
                    className="pw-settings-x"
                    aria-label={`删除角色 ${c.name}`}
                    title="删除角色（节点引用将标记失效）"
                    onClick={() => settingsActions.deleteCharacter(c.id)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="pw-settings-add"
                onClick={settingsActions.addCharacter}
              >
                ＋ 新增角色
              </button>
              <div className="pw-settings-group">地点</div>
              {settings.locations.map((l) => (
                <div
                  key={l.id}
                  className="pw-settings-item pw-draggable"
                  draggable
                  title="拖到索引卡设置地点，或拖到空白处新建场景"
                  onDragStart={(e: ReactDragEvent) => {
                    e.dataTransfer.setData(
                      PW_ENTITY_MIME,
                      JSON.stringify({ kind: 'location', id: l.id, name: l.name } satisfies EntityDragPayload),
                    )
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                >
                  <span className="pw-settings-item-body">
                    <EditableName
                      value={l.name}
                      ariaLabel={`地点名 ${l.name}`}
                      onChange={(name) => settingsActions.renameLocation(l.id, name)}
                    />
                  </span>
                  <button
                    type="button"
                    className="pw-settings-x"
                    aria-label={`删除地点 ${l.name}`}
                    title="删除地点（节点引用将标记失效）"
                    onClick={() => settingsActions.deleteLocation(l.id)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="pw-settings-add"
                onClick={settingsActions.addLocation}
              >
                ＋ 新增地点
              </button>
            </div>
          )}
          {tab === 'assets' && (
            <div className="pw-assets">
              <div className="pw-assets-hint">个人资产库 · 跨项目</div>
              {ASSET_CATEGORIES.map((cat) => (
                <div key={cat.kind} className="pw-assets-row">
                  <span>{cat.icon}</span>
                  <span className="pw-assets-label">{cat.label}</span>
                  <span className="pw-sp" />
                  <span className="pw-assets-count">{cat.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {open && (
        <PanelResizer direction={1} startWidth={width} onResize={onResize} />
      )}
    </aside>
  )
}
