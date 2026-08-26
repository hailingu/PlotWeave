import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import SegmentedControl from './SegmentedControl'
import PanelResizer from './PanelResizer'
import { ASSET_CATEGORIES } from '../sampleData'
import { PW_ENTITY_MIME, type EntityDragPayload } from '../dragDrop'
import { EditableName } from '../nodes/settings/NodeSettingsPanel'
import type { ProjectSettings } from '../settings'
import type { CanvasNode } from '../nodes/types'

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

/** 大纲行：类型决定缩进层级 + 归属节点 id（点击定位联动，§3.5）。 */
interface OutlineRow {
  id: string
  level: number
  label: string
}

/** 从画布节点派生大纲行：节拍 0 层、场景 1 层、对白/分支 2 层、分镜 3 层。 */
function outlineRows(nodes: CanvasNode[]): OutlineRow[] {
  return [...nodes]
    .sort((a, b) => a.position.x - b.position.x)
    .map((n) => {
      switch (n.type) {
        case 'beat':
          return { id: n.id, level: 0, label: `节拍 · ${n.data.name}` }
        case 'scene':
          return { id: n.id, level: 1, label: `场 ${String(n.data.sceneNo).padStart(2, '0')} · ${n.data.name}` }
        case 'dialogue':
          return { id: n.id, level: 2, label: `对白 · ${n.data.name}` }
        case 'branch':
          return { id: n.id, level: 2, label: `分支 · ${n.data.prompt}` }
        case 'shot':
          return { id: n.id, level: 3, label: `SHOT ${String(n.data.shotNo).padStart(2, '0')} · ${n.data.size}` }
      }
    })
}

interface LeftPanelProps {
  /** 面板展开状态：折叠时宽度动画到 0（弹簧），组件保持挂载以保留分段状态。 */
  open: boolean
  width: number
  onResize: (width: number) => void
  /** 画布节点，用于派生大纲行。 */
  nodes: CanvasNode[]
  /** 大纲 ⇄ 画布联动（§3.5）：点击大纲行选中并居中该节点。 */
  onLocate?: (id: string) => void
  /** 画布当前选中节点 id：大纲行反向高亮并滚动到可见。 */
  selectedId?: string
  /** 项目设定集（§5）：设定集分段的数据源。 */
  settings: ProjectSettings
  /** 设定集条目编辑动作（§5）。 */
  settingsActions: SettingsActions
}

/**
 * 编辑器左栏（docs/ui-design.md §3.4/§3.5/§8.1）：
 * 「大纲 / 设定集 / 资产」三分段。半透明材质 + 内容下滚动 + 边缘渐隐，
 * 无 1px 硬分隔线；内缘挂拖拽调宽手柄。
 * 大纲与画布双向联动（点击定位 / 选中高亮）；大纲拖拽排序、
 * 设定集条目编辑、资产拖拽引用随后续任务落地。
 */
export default function LeftPanel({
  open,
  width,
  onResize,
  nodes,
  onLocate,
  selectedId,
  settings,
  settingsActions,
}: LeftPanelProps) {
  const [tab, setTab] = useState<LeftTab>('outline')
  const rows = outlineRows(nodes)
  const outlineRef = useRef<HTMLDivElement>(null)

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
              {rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className={`pw-outline-row${row.id === selectedId ? ' pw-outline-on' : ''}`}
                  role="listitem"
                  data-level={row.level}
                  style={{ paddingLeft: 10 + row.level * 16 }}
                  onClick={() => onLocate?.(row.id)}
                  title="点击定位到画布"
                >
                  {row.label}
                </button>
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
