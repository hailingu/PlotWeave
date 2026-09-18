import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type RefObject,
} from 'react'
import type { Edge } from '@xyflow/react'
import { SegmentedControl } from './SegmentedControl'
import { PanelResizer } from './PanelResizer'
import { AssetsPanel } from './AssetsPanel'
import { SettingsList } from './SettingsList'
import { DocumentEditorDialog } from './DocumentEditorDialog'
import type { SettingsActions } from './settingsActions'
import {
  buildOutlineGroups,
  type OutlineDropTarget,
  type OutlineGroup,
} from '../outline'
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

/** 左栏分段（docs/ui-design.md §3.4）：大纲 = 故事脊线线性投影，设定集/资产 = 引用源。 */
type LeftTab = 'outline' | 'settings' | 'assets'

const TABS = [
  { value: 'outline' as const, label: '大纲' },
  { value: 'settings' as const, label: '设定集' },
  { value: 'assets' as const, label: '资产' },
]

interface LeftPanelProps {
  /** 面板展开状态：折叠时宽度动画到 0（弹簧），组件保持挂载以保留分段状态。 */
  readonly open: boolean
  readonly width: number
  readonly onResize: (width: number) => void
  /** 画布节点，用于派生大纲行。 */
  readonly nodes: CanvasNode[]
  /** 内容稳定投影（issue #157）：大纲派生按「内容 + x 序」键控重算，
   * 位置帧不逐帧重建。 */
  readonly contentNodes: CanvasNode[]
  /** 画布连线：下挂分镜的集归属随宿主场景派生（§7.2）。 */
  readonly edges: Edge[]
  /** 大纲 ⇄ 画布联动（§3.5）：点击大纲行选中并居中该节点。 */
  readonly onLocate?: (id: string) => void
  /** 画布当前选中节点 id：大纲行反向高亮并滚动到可见。 */
  readonly selectedId?: string
  /** 项目设定集（§5）：设定集分段的数据源。 */
  readonly settings: ProjectSettings
  /** 设定集条目编辑动作（§5）。 */
  readonly settingsActions: SettingsActions
  /** 设定文档编辑弹窗域（issue #126 状态提升到面板层）：editingDocId =
   * 弹窗挂载开关，open/close 由列表行点击与弹窗关闭动作调用；快捷键层
   * 据此挂起全局撤销/重做。 */
  readonly docDialog: {
    editingDocId: string | null
    open: (id: string) => void
    close: () => void
  }
  /** 集 = 编号 + 行内标题（§3.5）。 */
  readonly episodeTitles: Record<number, string>
  /** 当前聚焦的集；null = 无聚焦。 */
  readonly focusedEpisode: number | null
  /** 点击集行：该集提亮、其余退后；再点取消。 */
  readonly onFocusEpisode?: (episode: number | null) => void
  /** 集标题行内改名（编辑即命令）。 */
  readonly onRenameEpisode?: (episode: number, title: string) => void
  /** 大纲拖拽落点（§3.5：重排 sequence 边 / 跨组改集归属）。 */
  readonly onOutlineDrop?: (
    draggedId: string,
    target: OutlineDropTarget,
  ) => void
}

/**
 * 编辑器左栏（docs/ui-design.md §3.4/§3.5/§8.1）：
 * 「大纲 / 设定集 / 资产」三分段。半透明材质 + 内容下滚动 + 边缘渐隐，
 * 无 1px 硬分隔线；内缘挂拖拽调宽手柄。
 * 大纲按集分组（集 = 逻辑分类：点击集行画布聚焦，行内标题可编辑），
 * 与画布双向联动；大纲拖拽排序、资产拖拽引用随后续任务落地。
 */
type OutlineRow = { id: string; level: number; label: string }

/** 大纲拖放状态机（LeftPanel 拆分，issue #99）：行/组落点提示与 drop 收口
 * （level ≥ 3 不参与排序；无 onOutlineDrop 时整体禁用）。 */
function useOutlineDnD(
  onOutlineDrop:
    ((draggedId: string, target: OutlineDropTarget) => void) | undefined,
) {
  const [dropHint, setDropHint] = useState<DropHint>(null)
  const readDragged = (e: ReactDragEvent): string | null => {
    const id = e.dataTransfer.getData(OUTLINE_MIME)
    return id !== '' ? id : null
  }
  const rowDragOver = (e: ReactDragEvent, row: OutlineRow) => {
    if (row.level >= 3 || !onOutlineDrop) return
    if (!e.dataTransfer.types.includes(OUTLINE_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setDropHint({ kind: 'row', id: row.id, pos })
  }
  const rowDrop = (e: ReactDragEvent, row: OutlineRow) => {
    const dragged = readDragged(e)
    setDropHint(null)
    if (!dragged || dragged === row.id || row.level >= 3 || !onOutlineDrop)
      return
    e.preventDefault()
    const pos =
      dropHint?.kind === 'row' && dropHint.id === row.id
        ? dropHint.pos
        : 'after'
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
  return {
    dropHint,
    setDropHint,
    rowDragOver,
    rowDrop,
    groupDragOver,
    groupDrop,
  }
}

type OutlineDnD = ReturnType<typeof useOutlineDnD>

/** 大纲派生的「内容 + x 序」键控缓存（issue #157）：大纲行序按画布 x 排序，
 * 依赖位置——但拖拽过程帧绝大多数不改变相对 x 序。仅当业务内容
 * （contentNodes 换引用）或 x 序（跨节点拖动）变化时才换输入引用重算，
 * 同向小幅位移帧复用上次结果。 */
function useOutlineGroups(
  nodes: CanvasNode[],
  contentNodes: CanvasNode[],
  edges: Edge[],
  episodeTitles: Record<number, string>,
): OutlineGroup[] {
  // 序与 buildOutlineGroups 同语义（PR #194 评审 4027623775）：仅按 x 稳定
  // 排序（同 x 保持数组序），不带 id 次级键——次级键会让相等帧的序先于
  // 真实行序变化，越序后序不变、缓存不失效。缓存直接持有 id 数组并逐元素
  // 比较（评审 4027732274）：id 契约仅要求非空唯一，join('|') 等分隔符
  // 编码对 'a' 与 'a|a' 这类合法脏档 id 有歧义（两种顺序同串）。
  const order = nodes
    .slice()
    .sort((a, b) => a.position.x - b.position.x)
    .map((n) => n.id)
  const cacheRef = useRef<{
    content: CanvasNode[]
    order: string[]
    source: CanvasNode[]
  } | null>(null)
  const cache = cacheRef.current
  const sameOrder =
    cache?.order.length === order.length &&
    cache.order.every((id, i) => id === order[i])
  const stale = cache?.content !== contentNodes || !sameOrder
  if (stale) cacheRef.current = { content: contentNodes, order, source: nodes }
  const source = stale ? nodes : (cache?.source ?? nodes)
  return useMemo(
    () => buildOutlineGroups(source, edges, episodeTitles),
    [source, edges, episodeTitles],
  )
}

/** 大纲行按钮（LeftPanel 拆分，issue #99）：层级缩进、拖拽排序与定位；
 * level < 3 = 编剧侧四类（分镜随宿主场景，不参与拖拽排序）。 */
function OutlineRowButton({
  row,
  selectedId,
  onOutlineDrop,
  dnd,
  onLocate,
}: {
  readonly row: OutlineGroup['rows'][number]
  readonly selectedId: string | undefined
  readonly onOutlineDrop: LeftPanelProps['onOutlineDrop']
  readonly dnd: OutlineDnD
  readonly onLocate: ((id: string) => void) | undefined
}) {
  const draggable = row.level < 3 && onOutlineDrop !== undefined
  const hint =
    dnd.dropHint?.kind === 'row' && dnd.dropHint.id === row.id
      ? dnd.dropHint.pos
      : null
  return (
    <button
      type="button"
      className={[
        'pw-outline-row',
        row.id === selectedId ? ' pw-outline-on' : '',
        hint === 'before' ? ' pw-drop-above' : '',
        hint === 'after' ? ' pw-drop-below' : '',
      ].join('')}
      data-level={row.level}
      style={{ paddingLeft: 10 + row.level * 16 }}
      draggable={draggable}
      title={
        draggable ? '拖拽排序（重排剧情流）；点击定位到画布' : '点击定位到画布'
      }
      onDragStart={(e) => {
        e.dataTransfer.setData(OUTLINE_MIME, row.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => dnd.setDropHint(null)}
      onDragOver={(e) => dnd.rowDragOver(e, row)}
      onDragLeave={() =>
        dnd.setDropHint((h) =>
          h?.kind === 'row' && h.id === row.id ? null : h,
        )
      }
      onDrop={(e) => dnd.rowDrop(e, row)}
      onClick={() => onLocate?.(row.id)}
    >
      {row.label}
      {row.beat?.pending && (
        <span
          className="pw-beat-state pending"
          title="未被场景承载的节拍 = 节奏漏洞"
        >
          待兑现
        </span>
      )}
      {row.beat && !row.beat.pending && (
        <span
          className="pw-beat-state ok"
          title="承载场景（sequence 邻接派生）"
        >
          ✓ 兑现于 {row.beat.label}
        </span>
      )}
    </button>
  )
}

/** 大纲分组块（LeftPanel 拆分，issue #99）：集头（未分集/集号 + 聚焦 +
 * 改名 + 行数）与组内行。 */
function OutlineGroupBlock({
  group,
  selectedId,
  onOutlineDrop,
  dnd,
  focusedEpisode,
  onFocusEpisode,
  onRenameEpisode,
  onLocate,
}: {
  readonly group: OutlineGroup
  readonly selectedId: string | undefined
  readonly onOutlineDrop: LeftPanelProps['onOutlineDrop']
  readonly dnd: OutlineDnD
  readonly focusedEpisode: number | null
  readonly onFocusEpisode: ((episode: number) => void) | undefined
  readonly onRenameEpisode:
    ((episode: number, title: string) => void) | undefined
  readonly onLocate: ((id: string) => void) | undefined
}) {
  return (
    <div className="pw-outline-group">
      {group.episode === null ? (
        <div
          className={`pw-outline-ep static${dnd.dropHint?.kind === 'group' && dnd.dropHint.episode === null ? ' pw-drop-into' : ''}`}
          onDragOver={(e) => dnd.groupDragOver(e, null)}
          onDragLeave={() => dnd.setDropHint(null)}
          onDrop={(e) => dnd.groupDrop(e, null)}
        >
          未分集
        </div>
      ) : (
        <div
          className={`pw-outline-ep${dnd.dropHint?.kind === 'group' && dnd.dropHint.episode === group.episode ? ' pw-drop-into' : ''}`}
          onDragOver={(e) => dnd.groupDragOver(e, group.episode)}
          onDragLeave={() => dnd.setDropHint(null)}
          onDrop={(e) => dnd.groupDrop(e, group.episode)}
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
      {group.rows.map((row) => (
        <OutlineRowButton
          key={row.id}
          row={row}
          selectedId={selectedId}
          onOutlineDrop={onOutlineDrop}
          dnd={dnd}
          onLocate={onLocate}
        />
      ))}
    </div>
  )
}

/** 反向联动（LeftPanel 拆分，issue #99）：画布选中变化时大纲行滚动到可
 * 见（不抢横向滚动）。 */
function useOutlineScrollFollow(
  tab: LeftTab,
  selectedId: string | undefined,
  outlineRef: RefObject<HTMLElement>,
) {
  useEffect(() => {
    if (tab !== 'outline' || !selectedId) return
    outlineRef.current
      ?.querySelector('.pw-outline-on')
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedId, tab, outlineRef])
}

/** 大纲分页主体（LeftPanel 拆分，issue #99）：原生 section + aria-label
 * （隐式 region，替代 div role="group"，S6819）承载分组列表。 */
function OutlinePane({
  groups,
  outlineRef,
  selectedId,
  onOutlineDrop,
  dnd,
  focusedEpisode,
  onFocusEpisode,
  onRenameEpisode,
  onLocate,
}: {
  readonly groups: OutlineGroup[]
  readonly outlineRef: RefObject<HTMLElement>
  readonly selectedId: string | undefined
  readonly onOutlineDrop: LeftPanelProps['onOutlineDrop']
  readonly dnd: OutlineDnD
  readonly focusedEpisode: number | null
  readonly onFocusEpisode: ((episode: number) => void) | undefined
  readonly onRenameEpisode:
    ((episode: number, title: string) => void) | undefined
  readonly onLocate: ((id: string) => void) | undefined
}) {
  return (
    <section className="pw-outline" aria-label="故事大纲" ref={outlineRef}>
      {groups.map((group) => (
        <OutlineGroupBlock
          key={group.episode ?? 'none'}
          group={group}
          selectedId={selectedId}
          onOutlineDrop={onOutlineDrop}
          dnd={dnd}
          focusedEpisode={focusedEpisode}
          onFocusEpisode={onFocusEpisode}
          onRenameEpisode={onRenameEpisode}
          onLocate={onLocate}
        />
      ))}
    </section>
  )
}

/** 文档编辑器弹窗（LeftPanel 拆分，issue #99）：按挂载 id 解析当前文档并
 * 渲染弹窗，保存一次派发；doc 为 null 时不渲染。解析失败（底层文档被
 * 删除/撤销）即清空挂载 id——模态会话随卸载同步结束，全局快捷键不因
 * 残留 id 持续挂起（issue #126，PR #185 评审）。 */
function DocumentEditDialog({
  settings,
  docDialog,
  onSave,
}: {
  readonly settings: ProjectSettings
  readonly docDialog: LeftPanelProps['docDialog']
  readonly onSave: SettingsActions['updateDocument']
}) {
  const doc =
    settings.documents?.find((d) => d.id === docDialog.editingDocId) ?? null
  useEffect(() => {
    if (docDialog.editingDocId !== null && doc === null) docDialog.close()
  }, [docDialog, doc])
  if (doc === null) return null
  return (
    <DocumentEditorDialog
      doc={doc}
      settings={settings}
      onSave={onSave}
      onClose={docDialog.close}
    />
  )
}

/** 左侧面板（§3.4/§3.5：大纲 / 设定集 / 资产分段）：大纲行定位画布、
 * 设定集与资产条目拖拽上画布；宽度经 PanelResizer 调整。 */
export function LeftPanel({
  open,
  width,
  onResize,
  nodes,
  contentNodes,
  edges,
  onLocate,
  selectedId,
  settings,
  settingsActions,
  docDialog,
  episodeTitles,
  focusedEpisode,
  onFocusEpisode,
  onRenameEpisode,
  onOutlineDrop,
}: LeftPanelProps) {
  const [tab, setTab] = useState<LeftTab>('outline')
  const groups = useOutlineGroups(nodes, contentNodes, edges, episodeTitles)
  const outlineRef = useRef<HTMLElement>(null)
  const dnd = useOutlineDnD(onOutlineDrop)
  useOutlineScrollFollow(tab, selectedId, outlineRef)

  return (
    <aside
      className={`pw-panel pw-panel-left${open ? '' : ' pw-panel-closed'}`}
      style={{ width: open ? width : 0 }}
      aria-hidden={!open}
    >
      <div className="pw-panel-inner" style={{ width }}>
        <div className="pw-panel-head">
          <SegmentedControl
            groupLabel="左栏分段"
            options={TABS}
            value={tab}
            onChange={setTab}
          />
        </div>
        <div className="pw-panel-scroll">
          {tab === 'outline' && (
            <OutlinePane
              groups={groups}
              outlineRef={outlineRef}
              selectedId={selectedId}
              onOutlineDrop={onOutlineDrop}
              dnd={dnd}
              focusedEpisode={focusedEpisode}
              onFocusEpisode={onFocusEpisode}
              onRenameEpisode={onRenameEpisode}
              onLocate={onLocate}
            />
          )}
          {tab === 'settings' && (
            <SettingsList
              settings={settings}
              actions={settingsActions}
              onOpenDocument={docDialog.open}
            />
          )}
          {tab === 'assets' && <AssetsPanel />}
        </div>
      </div>
      {/* 文档编辑器弹窗（issue 56）：挂载状态在面板域（issue #126），
          保存一次派发；草稿协调与 id 清理见 DocumentEditDialog */}
      <DocumentEditDialog
        settings={settings}
        docDialog={docDialog}
        onSave={settingsActions.updateDocument}
      />
      {open && (
        <PanelResizer direction={1} startWidth={width} onResize={onResize} />
      )}
    </aside>
  )
}
