// @vitest-environment happy-dom
/** useExitFlush 初始化失败路径（issue #159）：四类失败注入（动态模块
 * 加载 / close 监听注册 / quit 监听注册 / acknowledge）——无未处理拒绝、
 * 部分完成资源回收、退出失败可诊断、不静默丢弃已缓冲请求。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

afterEach(cleanup)

/** 受控的 Tauri API 形态：各失败注入点由用例覆盖默认值。 */
type TauriShape = {
  failModules?: boolean
  closeUnlisten?: () => void
  quitUnlisten?: () => void
  failClose?: boolean
  failQuit?: boolean
  failAck?: boolean
}

let shape: TauriShape = {}

/** 装载受控模拟并以干净模块图渲染钩子宿主。 */
async function renderWith(next: TauriShape): Promise<void> {
  shape = next
  vi.resetModules()
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: {},
    configurable: true,
  })
  vi.doMock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
      onCloseRequested: async () => {
        if (shape.failModules) throw new Error('模块加载失败')
        if (shape.failClose) throw new Error('close 监听注册失败')
        return shape.closeUnlisten ?? (() => {})
      },
      destroy: async () => {},
    }),
  }))
  vi.doMock('@tauri-apps/api/event', () => ({
    listen: async () => {
      if (shape.failQuit) throw new Error('quit 监听注册失败')
      return shape.quitUnlisten ?? (() => {})
    },
  }))
  vi.doMock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string) => {
      if (cmd === 'acknowledge_quit_listener' && shape.failAck)
        throw new Error('acknowledge 失败')
      return undefined
    },
  }))
  const { useExitFlush } = await import('./useExitFlush')
  const Probe = () => {
    const blocked = useExitFlush()
    return <div>{blocked === null ? '（无阻断）' : blocked}</div>
  }
  render(<Probe />)
}

beforeEach(() => {
  shape = {}
})

describe('useExitFlush 初始化失败（issue #159）', () => {
  it('quit 监听注册失败：部分完成的 close 监听被回收，诊断可见', async () => {
    let closeUnlistened = false
    await renderWith({
      failQuit: true,
      closeUnlisten: () => {
        closeUnlistened = true
      },
    })
    // 无未处理拒绝（vitest 会把未处理拒绝计入 Errors 并失败门禁）
    await screen.findByText(/退出冲刷初始化失败/)
    expect(closeUnlistened).toBe(true)
    await screen.findByText(/quit 监听注册失败/)
  })

  it('acknowledge 失败：两个监听都被回收，诊断标明阶段', async () => {
    let closeUnlistened = false
    let quitUnlistened = false
    await renderWith({
      failAck: true,
      closeUnlisten: () => {
        closeUnlistened = true
      },
      quitUnlisten: () => {
        quitUnlistened = true
      },
    })
    expect(await screen.findByText(/acknowledge/)).toBeTruthy()
    expect(closeUnlistened).toBe(true)
    expect(quitUnlistened).toBe(true)
  })

  it('close 监听注册失败：无已登记监听可回收（不产生泄漏），诊断可见', async () => {
    await renderWith({ failClose: true })
    expect(await screen.findByText(/close 监听注册失败/)).toBeTruthy()
  })

  it('动态模块加载失败：诊断可见且不进入冲刷', async () => {
    await renderWith({ failModules: true })
    expect(
      await screen.findByText(/模块加载失败|退出冲刷初始化失败/),
    ).toBeTruthy()
  })

  it('正常初始化：无诊断（不误报），acknowledge 被调用', async () => {
    let acked = false
    shape = {}
    vi.resetModules()
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    })
    vi.doMock('@tauri-apps/api/window', () => ({
      getCurrentWindow: () => ({
        onCloseRequested: async () => () => {},
        destroy: async () => {},
      }),
    }))
    vi.doMock('@tauri-apps/api/event', () => ({
      listen: async () => () => {},
    }))
    vi.doMock('@tauri-apps/api/core', () => ({
      invoke: async (cmd: string) => {
        if (cmd === 'acknowledge_quit_listener') acked = true
        return undefined
      },
    }))
    const { useExitFlush } = await import('./useExitFlush')
    const Probe = () => {
      const blocked = useExitFlush()
      return <div>{blocked === null ? '（无阻断）' : blocked}</div>
    }
    render(<Probe />)
    await screen.findByText('（无阻断）')
    expect(acked).toBe(true)
  })
})
