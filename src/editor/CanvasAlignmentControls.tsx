/** 选中节点对齐工具条；使用 React Flow 控件的键盘、主题与位置容器。 */
import { Controls } from '@xyflow/react'
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

/** 对齐命令不改变选中态；不足两个节点时禁用并保留可发现的入口。 */
export function CanvasAlignmentControls({
  selectedCount,
  onAlignNodes,
}: {
  readonly selectedCount: number
  readonly onAlignNodes: (alignment: CanvasAlignment) => void
}) {
  return (
    <Controls
      position="top-center"
      orientation="horizontal"
      showZoom={false}
      showFitView={false}
      showInteractive={false}
      aria-label="选中节点对齐"
    >
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
    </Controls>
  )
}
