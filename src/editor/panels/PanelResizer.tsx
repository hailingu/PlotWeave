/**
 * 面板拖拽调宽手柄（docs/ui-design.md §3.4：220–320pt）。
 * 挂在面板内缘：左栏手柄在右缘（direction = 1，向右拖变宽），
 * 右栏手柄在左缘（direction = -1，向左拖变宽）。
 * 宽度钳制与回调由父组件持有，本组件只负责指针手势。
 */
interface PanelResizerProps {
  /** 方向系数：右移增大宽度 = 1，右移减小宽度 = -1。 */
  direction: 1 | -1
  /** 拖拽中持续回调目标宽度（已按 direction 换算，未钳制）。 */
  onResize: (width: number) => void
  /** 拖拽起始时的面板宽度。 */
  startWidth: number
}

export const PANEL_WIDTH_MIN = 220
export const PANEL_WIDTH_MAX = 320

export default function PanelResizer({ direction, onResize, startWidth }: PanelResizerProps) {
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const move = (ev: PointerEvent) => {
      const next = startWidth + (ev.clientX - startX) * direction
      onResize(Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, next)))
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div
      className="pw-panel-resizer"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={handlePointerDown}
    />
  )
}
