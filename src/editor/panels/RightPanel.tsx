import SegmentedControl from './SegmentedControl'
import PanelResizer from './PanelResizer'
import type { CanvasNode } from '../nodes/types'

/** 右栏分段（docs/ui-design.md §3.4）：检查器 = 选中节点的字段视图；✦AI = 对话面板。 */
export type RightTab = 'inspector' | 'ai'

const TABS = [
  { value: 'inspector' as const, label: '检查器' },
  { value: 'ai' as const, label: '✦ AI' },
]

const TYPE_LABELS: Record<CanvasNode['type'], string> = {
  scene: '场景 · 索引卡',
  dialogue: '对白 · 气泡流',
  beat: '节奏卡 · 节拍胶囊',
  branch: '分支 · 岔路路标',
  shot: '分镜卡 · 监视器卡',
}

/** 检查器字段行：按节点类型派生只读视图（编辑随后续 ⚙️ 设置面板任务落地）。 */
function inspectorRows(node: CanvasNode): { label: string; value: string }[] {
  switch (node.type) {
    case 'scene':
      return [
        { label: '名称', value: node.data.name },
        { label: '场号', value: `SCENE ${String(node.data.sceneNo).padStart(2, '0')}` },
        { label: '内外景', value: node.data.interior ? '内' : '外' },
        { label: '地点', value: node.data.location },
        { label: '时间', value: node.data.time },
        ...(node.data.weather ? [{ label: '天气', value: node.data.weather }] : []),
        { label: '分镜', value: `🎞 ${node.data.shotCount} 镜` },
        { label: '梗概', value: node.data.synopsis },
        { label: '在场角色', value: node.data.characters.map((c) => c.label).join(' / ') || '—' },
      ]
    case 'dialogue': {
      const speakers = new Set(
        node.data.lines.flatMap((l) => (l.kind === 'line' && l.speaker ? [l.speaker.label] : [])),
      )
      const actions = node.data.lines.filter((l) => l.kind === 'action').length
      return [
        { label: '名称', value: node.data.name },
        { label: '人物', value: [...speakers].join(' / ') },
        { label: '台词', value: `${node.data.lines.length - actions} 句` },
        { label: '动作行', value: `${actions} 行` },
      ]
    }
    case 'beat':
      return [
        { label: '名称', value: node.data.name },
        { label: '基调', value: node.data.tone },
      ]
    case 'branch':
      return [
        { label: '问句', value: node.data.prompt },
        { label: '选项', value: node.data.options.join(' / ') },
      ]
    case 'shot':
      return [
        { label: '镜号', value: `SHOT ${String(node.data.shotNo).padStart(2, '0')}` },
        { label: '景别', value: node.data.size },
        { label: '画面描述', value: node.data.picture },
        { label: '镜头 PROMPT', value: node.data.prompt },
        { label: '引用', value: node.data.refs.map((r) => r.label).join(' / ') || '—' },
      ]
  }
}

interface RightPanelProps {
  open: boolean
  width: number
  onResize: (width: number) => void
  tab: RightTab
  onTabChange: (tab: RightTab) => void
  /** 画布当前选中节点；无选中时检查器显示空态。 */
  selectedNode?: CanvasNode
}

/**
 * 编辑器右栏（docs/ui-design.md §3.4/§6）：
 * 「检查器 / ✦AI」分段。检查器展示选中节点的派生字段（只读），
 * ✦AI 为对话面板结构占位——BYOK provider 未配置时给引导卡，
 * 输入区常驻「了解当前画布」上下文标识。改动预览卡随后续任务落地。
 */
export default function RightPanel({
  open,
  width,
  onResize,
  tab,
  onTabChange,
  selectedNode,
}: RightPanelProps) {
  const rows = selectedNode ? inspectorRows(selectedNode) : []

  return (
    <aside
      className={`pw-panel pw-panel-right${open ? '' : ' pw-panel-closed'}`}
      style={{ width: open ? width : 0 }}
      aria-hidden={!open}
    >
      {open && (
        <PanelResizer direction={-1} startWidth={width} onResize={onResize} />
      )}
      <div className="pw-panel-inner" style={{ width }}>
        <div className="pw-panel-head">
          <SegmentedControl groupLabel="右栏分段" options={TABS} value={tab} onChange={onTabChange} />
        </div>
        <div className="pw-panel-scroll">
          {tab === 'inspector' &&
            (selectedNode ? (
              <div className="pw-inspector">
                <div className="pw-inspector-type">{TYPE_LABELS[selectedNode.type]}</div>
                {rows.map((row) => (
                  <div key={row.label} className="pw-inspector-row">
                    <span className="pw-inspector-label">{row.label}</span>
                    <span className="pw-inspector-value">{row.value}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="pw-empty">在画布中选择一个节点，查看它的字段。</div>
            ))}
          {tab === 'ai' && (
            <div className="pw-ai">
              <div className="pw-ai-guide">
                <div className="pw-ai-guide-title">尚未接入 AI 服务</div>
                <p>在设置页配置 BYOK provider 后，可在这里与 AI 讨论剧情；AI 的改动会先以预览卡呈现，确认后才执行。</p>
                <button type="button" className="pw-ai-guide-btn" disabled>
                  前往设置页
                </button>
              </div>
              <div className="pw-ai-input">
                <input type="text" disabled placeholder="配置 provider 后可输入…" aria-label="AI 对话输入" />
                <span className="pw-ai-ctx">◈ 了解当前画布</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
