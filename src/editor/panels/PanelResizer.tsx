/**
 * 面板调宽手柄（docs/ui-design.md §3.4：220–320pt）：指针拖拽与键盘
 * 调节（issue #264）共用父层宽度状态与同一钳制。挂在面板内缘：左栏
 * 手柄在右缘（direction = 1，向右拖 / 按 → 变宽），右栏手柄在左缘
 * （direction = -1，向左拖 / 按 → 变宽）。宽度钳制与回调由父组件持有，
 * 本组件只负责手势：指针（pointerdown/move/up/cancel/lostpointercapture）
 * 与键盘（←/→ 每次 10pt、Home/End 直达边界——处理仅在手柄聚焦时发生，
 * 面板内容的输入与方向键不受拦截）。
 * 监听与焦点以 effect 装配原生事件（useEditorHotkeys 同款口径）：
 * hr 是 ARIA APG 的焦点分隔条模式，JSX 事件属性与 tabIndex 写法会被
 * SonarJS S6845/S6847 按非交互元素规则误伤。
 */
import { useEffect, useRef } from 'react'

interface PanelResizerProps {
  /** 方向系数：右移增大宽度 = 1，右移减小宽度 = -1。 */
  readonly direction: 1 | -1
  /** 键盘入口的可访问名称（左右栏各自传入）。 */
  readonly label: string
  /** 当前面板宽度：拖拽起点与键盘步进基值，也是 aria 当前值。 */
  readonly width: number
  /** 调宽持续回调目标宽度（已按 direction 换算并钳制到 220–320）。 */
  readonly onResize: (width: number) => void
}

/** 面板宽度下限（pt，§3.4）。 */
export const PANEL_WIDTH_MIN = 220
/** 面板宽度上限（pt，§3.4）。 */
export const PANEL_WIDTH_MAX = 320
/** 键盘单次按键的调宽步长（pt，issue #264）。 */
export const PANEL_WIDTH_KEY_STEP = 10

/** 钳制到 §3.4 宽度范围（指针与键盘路径共用）。 */
function clampPanelWidth(width: number): number {
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, width))
}

/** 面板调宽手柄（语义见模块头）：只负责手势，宽度状态与回调由父组件持有。 */
export function PanelResizer({
  direction,
  label,
  width,
  onResize,
}: PanelResizerProps) {
  const handleRef = useRef<HTMLHRElement>(null)

  useEffect(() => {
    const el = handleRef.current
    if (!el) return
    // 键盘可达：焦点序列中的分隔条（ARIA APG 焦点分隔条模式）
    el.tabIndex = 0
    const startDrag = (startX: number) => {
      const move = (ev: PointerEvent) => {
        const next = width + (ev.clientX - startX) * direction
        onResize(clampPanelWidth(next))
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
    const onPointerDown = (ev: PointerEvent) => {
      ev.preventDefault()
      el.setPointerCapture(ev.pointerId)
      startDrag(ev.clientX)
    }
    const widenKey = direction === 1 ? 'ArrowRight' : 'ArrowLeft'
    const narrowKey = direction === 1 ? 'ArrowLeft' : 'ArrowRight'
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === widenKey) {
        ev.preventDefault()
        onResize(clampPanelWidth(width + PANEL_WIDTH_KEY_STEP))
      } else if (ev.key === narrowKey) {
        ev.preventDefault()
        onResize(clampPanelWidth(width - PANEL_WIDTH_KEY_STEP))
      } else if (ev.key === 'Home') {
        ev.preventDefault()
        onResize(PANEL_WIDTH_MIN)
      } else if (ev.key === 'End') {
        ev.preventDefault()
        onResize(PANEL_WIDTH_MAX)
      }
    }
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('keydown', onKeyDown)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('keydown', onKeyDown)
    }
  }, [direction, width, onResize])

  return (
    // 原生 hr 承载分隔语义（S6819）；可访问值随渲染更新，边框与外距在
    // .pw-panel-resizer 重置
    <hr
      ref={handleRef}
      className="pw-panel-resizer"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={PANEL_WIDTH_MIN}
      aria-valuemax={PANEL_WIDTH_MAX}
      aria-valuenow={width}
    />
  )
}
