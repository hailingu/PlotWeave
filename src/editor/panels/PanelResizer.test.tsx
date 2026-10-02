// @vitest-environment happy-dom
/**
 * 面板调宽手柄（issue #264）：指针拖拽（含 pointercancel /
 * lostpointercapture 清理）与键盘调节（方向键 ±10pt 步进、Home/End
 * 直达边界、方向语义随 direction 翻转、重复按键经父状态累计且在
 * 220–320 钳制）共用同一钳制；键盘处理仅发生在手柄元素上，面板内容
 * 的输入与方向键不被拦截；可访问语义（separator 角色、名称、方向、
 * 当前值与范围）与键盘可达（tabIndex、可聚焦）就位。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import {
  PanelResizer,
  PANEL_WIDTH_KEY_STEP,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
} from './PanelResizer'

afterEach(cleanup)

interface HarnessProps {
  readonly direction: 1 | -1
  readonly initialWidth?: number
}

/** 父层状态接线复刻（EditorLayout：宽度由父持有，回调回灌）。 */
function Harness({ direction, initialWidth = 280 }: HarnessProps) {
  const [width, setWidth] = useState(initialWidth)
  return (
    <PanelResizer
      direction={direction}
      label={direction === 1 ? '调整左栏宽度' : '调整右栏宽度'}
      width={width}
      onResize={setWidth}
    />
  )
}

const handleOf = (name: string) =>
  screen.getByRole('separator', { name }) as HTMLHRElement

describe('PanelResizer（键盘调宽，issue #264）', () => {
  it('左栏手柄：ArrowRight 增宽、ArrowLeft 减宽，每次 10pt 经父状态累计', () => {
    render(<Harness direction={1} />)
    const handle = handleOf('调整左栏宽度')
    handle.focus()
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle.getAttribute('aria-valuenow')).toBe(
      String(280 + PANEL_WIDTH_KEY_STEP),
    )
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle.getAttribute('aria-valuenow')).toBe(
      String(280 + PANEL_WIDTH_KEY_STEP * 2),
    )
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle.getAttribute('aria-valuenow')).toBe(
      String(280 + PANEL_WIDTH_KEY_STEP),
    )
  })

  it('右栏手柄：方向语义随 direction 翻转（ArrowLeft 增宽、ArrowRight 减宽）', () => {
    render(<Harness direction={-1} />)
    const handle = handleOf('调整右栏宽度')
    handle.focus()
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle.getAttribute('aria-valuenow')).toBe(
      String(280 + PANEL_WIDTH_KEY_STEP),
    )
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle.getAttribute('aria-valuenow')).toBe('280')
  })

  it('重复按键在上限钳制：不越过 320', () => {
    render(<Harness direction={1} initialWidth={315} />)
    const handle = handleOf('调整左栏宽度')
    for (let i = 0; i < 4; i += 1) {
      fireEvent.keyDown(handle, { key: 'ArrowRight' })
    }
    expect(handle.getAttribute('aria-valuenow')).toBe(String(PANEL_WIDTH_MAX))
  })

  it('重复按键在下限钳制：不越过 220', () => {
    render(<Harness direction={1} initialWidth={225} />)
    const handle = handleOf('调整左栏宽度')
    for (let i = 0; i < 3; i += 1) {
      fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    }
    expect(handle.getAttribute('aria-valuenow')).toBe(String(PANEL_WIDTH_MIN))
  })

  it('Home / End 直达最小 / 最大宽度', () => {
    render(<Harness direction={1} />)
    const handle = handleOf('调整左栏宽度')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(handle.getAttribute('aria-valuenow')).toBe(String(PANEL_WIDTH_MIN))
    fireEvent.keyDown(handle, { key: 'End' })
    expect(handle.getAttribute('aria-valuenow')).toBe(String(PANEL_WIDTH_MAX))
  })

  it('键盘处理仅在手柄上：面板内容元素的方向键不触发调宽', () => {
    const onResize = vi.fn()
    render(
      <>
        <input aria-label="面板内输入" />
        <PanelResizer
          direction={1}
          label="调整左栏宽度"
          width={280}
          onResize={onResize}
        />
      </>,
    )
    const input = screen.getByLabelText('面板内输入') as HTMLInputElement
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    fireEvent.keyDown(input, { key: 'Home' })
    expect(onResize).not.toHaveBeenCalled()
  })

  it('键盘可达与可访问语义：tabIndex、方向、范围与当前值', () => {
    render(<Harness direction={1} />)
    const handle = handleOf('调整左栏宽度')
    expect(handle.tabIndex).toBe(0)
    expect(handle.getAttribute('aria-orientation')).toBe('vertical')
    expect(handle.getAttribute('aria-valuemin')).toBe(String(PANEL_WIDTH_MIN))
    expect(handle.getAttribute('aria-valuemax')).toBe(String(PANEL_WIDTH_MAX))
    expect(handle.getAttribute('aria-valuenow')).toBe('280')
    handle.focus()
    expect(document.activeElement).toBe(handle)
  })
})

describe('PanelResizer（指针拖拽回归，issue #264）', () => {
  it('拖拽按 direction 换算并钳制到 220–320', () => {
    const widen = vi.fn()
    render(
      <PanelResizer
        direction={1}
        label="调整左栏宽度"
        width={280}
        onResize={widen}
      />,
    )
    const handle = handleOf('调整左栏宽度')
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 140, pointerId: 1 })
    expect(widen).toHaveBeenLastCalledWith(320)
    fireEvent.pointerMove(handle, { clientX: -500, pointerId: 1 })
    expect(widen).toHaveBeenLastCalledWith(PANEL_WIDTH_MIN)
    fireEvent.pointerUp(handle, { pointerId: 1 })

    const narrow = vi.fn()
    render(
      <PanelResizer
        direction={-1}
        label="调整右栏宽度"
        width={280}
        onResize={narrow}
      />,
    )
    const rightHandle = handleOf('调整右栏宽度')
    fireEvent.pointerDown(rightHandle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(rightHandle, { clientX: 60, pointerId: 1 })
    expect(narrow).toHaveBeenLastCalledWith(320)
    fireEvent.pointerUp(rightHandle, { pointerId: 1 })
  })

  it.each(['pointerup', 'pointercancel', 'lostpointercapture'] as const)(
    '%s 结束后清理监听，后续 pointermove 不再调宽',
    (endEvent) => {
      const onResize = vi.fn()
      render(
        <PanelResizer
          direction={1}
          label="调整左栏宽度"
          width={280}
          onResize={onResize}
        />,
      )
      const handle = handleOf('调整左栏宽度')
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
      fireEvent.pointerMove(handle, { clientX: 130, pointerId: 1 })
      expect(onResize).toHaveBeenCalledTimes(1)
      // 清理监听挂在元素上，直接派发原生事件名（fireEvent 的驼峰别名
      // 不含 lostpointercapture）
      fireEvent(handle, new Event(endEvent))
      fireEvent.pointerMove(handle, { clientX: 200, pointerId: 1 })
      expect(onResize).toHaveBeenCalledTimes(1)
    },
  )
})
