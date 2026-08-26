import { useState } from 'react'
import SegmentedControl from './SegmentedControl'
import PanelResizer from './PanelResizer'
import {
  ASSET_CATEGORIES,
  SAMPLE_CHARACTERS,
  SAMPLE_LOCATIONS,
} from '../sampleData'
import type { CanvasNode } from '../nodes/types'

/** 左栏分段（docs/ui-design.md §3.4）：大纲 = 故事脊线线性投影，设定集/资产 = 引用源。 */
type LeftTab = 'outline' | 'settings' | 'assets'

const TABS = [
  { value: 'outline' as const, label: '大纲' },
  { value: 'settings' as const, label: '设定集' },
  { value: 'assets' as const, label: '资产' },
]

/** 大纲行：类型决定缩进层级，线性投影画布的剧情流（§3.5 结构占位，点击联动随后续任务）。 */
interface OutlineRow {
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
          return { level: 0, label: `节拍 · ${n.data.name}` }
        case 'scene':
          return { level: 1, label: `场 ${String(n.data.sceneNo).padStart(2, '0')} · ${n.data.name}` }
        case 'dialogue':
          return { level: 2, label: `对白 · ${n.data.name}` }
        case 'branch':
          return { level: 2, label: `分支 · ${n.data.prompt}` }
        case 'shot':
          return { level: 3, label: `SHOT ${String(n.data.shotNo).padStart(2, '0')} · ${n.data.size}` }
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
}

/**
 * 编辑器左栏（docs/ui-design.md §3.4/§3.5/§8.1）：
 * 「大纲 / 设定集 / 资产」三分段。半透明材质 + 内容下滚动 + 边缘渐隐，
 * 无 1px 硬分隔线；内缘挂拖拽调宽手柄。首版为结构占位——
 * 大纲选中联动、设定集条目编辑、资产拖拽引用随后续任务落地。
 */
export default function LeftPanel({ open, width, onResize, nodes }: LeftPanelProps) {
  const [tab, setTab] = useState<LeftTab>('outline')
  const rows = outlineRows(nodes)

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
            <div className="pw-outline" role="list" aria-label="故事大纲">
              {rows.map((row, i) => (
                <div
                  key={i}
                  className="pw-outline-row"
                  role="listitem"
                  data-level={row.level}
                  style={{ paddingLeft: 10 + row.level * 16 }}
                >
                  {row.label}
                </div>
              ))}
            </div>
          )}
          {tab === 'settings' && (
            <div className="pw-settings">
              <div className="pw-settings-group">角色</div>
              {SAMPLE_CHARACTERS.map((c) => (
                <div key={c.name} className="pw-settings-item">
                  <span className="pw-av" style={{ background: c.avatar.gradient }}>
                    {c.avatar.label}
                  </span>
                  <span className="pw-settings-item-body">
                    <span className="pw-settings-item-name">{c.name}</span>
                    <span className="pw-settings-item-note">{c.bio}</span>
                  </span>
                </div>
              ))}
              <div className="pw-settings-group">地点</div>
              {SAMPLE_LOCATIONS.map((l) => (
                <div key={l.name} className="pw-settings-item">
                  <span className="pw-settings-item-body">
                    <span className="pw-settings-item-name">📍 {l.name}</span>
                    <span className="pw-settings-item-note">{l.note}</span>
                  </span>
                </div>
              ))}
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
