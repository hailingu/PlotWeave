/** 整图排布与选中节点对齐共用画布中央工具条和现有图动作。 */
import { Panel } from '@xyflow/react'
import type { CanvasAlignment } from './canvasAlignment'

/** 对齐命令与中文可访问名称的固定映射。 */
const ACTIONS: { alignment: CanvasAlignment; label: string; path: string }[] = [
  {
    alignment: 'left',
    label: '左对齐',
    path: 'M4 3v18M8 6h12v4H8zM8 14h8v4H8z',
  },
  {
    alignment: 'center',
    label: '水平居中',
    path: 'M12 2v20M4 6h16v4H4zM7 14h10v4H7z',
  },
  {
    alignment: 'right',
    label: '右对齐',
    path: 'M20 3v18M4 6h12v4H4zM8 14h8v4H8z',
  },
  {
    alignment: 'top',
    label: '顶部对齐',
    path: 'M3 4h18M6 8h4v12H6zM14 8h4v8h-4z',
  },
  {
    alignment: 'middle',
    label: '垂直居中',
    path: 'M2 12h20M6 4h4v16H6zM14 7h4v10h-4z',
  },
  {
    alignment: 'bottom',
    label: '底部对齐',
    path: 'M3 20h18M6 4h4v12H6zM14 8h4v8h-4z',
  },
]

/** 自动排布只受空图约束；六方向对齐独立要求至少两个选中节点。 */
export function CanvasAlignmentControls({
  selectedCount,
  onAlignNodes,
  autoLayoutDisabled,
  onAutoLayout,
}: {
  readonly selectedCount: number
  readonly onAlignNodes: (alignment: CanvasAlignment) => void
  /** 空图不发起整图排布，与选中数量无关。 */
  readonly autoLayoutDisabled: boolean
  /** 复用既有整图位置历史、视口适配和保存动作。 */
  readonly onAutoLayout: () => void
}) {
  return (
    <Panel
      position="top-center"
      className="react-flow__controls horizontal"
      role="group"
      aria-label="画布排布"
    >
      <button
        type="button"
        className="react-flow__controls-button"
        title="自动排布"
        aria-label="自动排布"
        disabled={autoLayoutDisabled}
        onClick={onAutoLayout}
      >
        <AutoLayoutIcon />
      </button>

      {ACTIONS.map(({ alignment, label, path }) => (
        <button
          key={alignment}
          type="button"
          className="react-flow__controls-button"
          title={`${label}（至少选中两个节点）`}
          aria-label={label}
          disabled={selectedCount < 2}
          onClick={() => onAlignNodes(alignment)}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d={path} />
          </svg>
        </button>
      ))}
    </Panel>
  )
}

/** 自动排布按钮图标：三卡对齐 + 归位箭头，表达「整理布局」。 */
function AutoLayoutIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="6" rx="1.2" />
      <rect x="3" y="12" width="7" height="6" rx="1.2" />
      <path d="M14 5h7M14 9h4" strokeLinecap="round" />
      <path d="M14 14h7M14 18h4" strokeLinecap="round" />
    </svg>
  )
}
