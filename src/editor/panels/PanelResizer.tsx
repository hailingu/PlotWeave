/**
 * 面板拖拽调宽手柄（docs/ui-design.md §3.4：220–320pt）。
 * 挂在面板内缘：左栏手柄在右缘（direction = 1，向右拖变宽），
 * 右栏手柄在左缘（direction = -1，向左拖变宽）。
 * 宽度钳制与回调由父组件持有，本组件只负责指针手势。
 */
import type { PointerEvent as ReactPointerEvent } from 'react'

interface PanelResizerProps {
  /** 方向系数：右移增大宽度 = 1，右移减小宽度 = -1。 */
  readonly direction: 1 | -1
  /** 拖拽中持续回调目标宽度（已按 direction 换算，未钳制）。 */
  readonly onResize: (width: number) => void
  /** 拖拽起始时的面板宽度。 */
  readonly startWidth: number
}

export const PANEL_WIDTH_MIN = 220
export const PANEL_WIDTH_MAX = 320

export default function PanelResizer({ direction, onResize, startWidth }: PanelResizerProps) {
  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const move = (ev: PointerEvent) => {
      const next = startWidth + (ev.clientX - startX) * direction
      onResize(Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, next)))
    }
    // pointercancel / lostpointercapture 一并清理，防异常中断后监听器残留
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('lostpointercapture', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('lostpointercapture', up)
  }

  return (
    // 原生 hr 承载分隔语义（S6819）；边框与外距在 .pw-panel-resizer 重置
    <hr
      className="pw-panel-resizer"
      aria-orientation="vertical"
      onPointerDown={handlePointerDown}
    />
  )
}
