/**
 * 类型化入口的转发契约（issue #394 评审 5339899090）：ipcInvoke 原样把
 * 命令名与参数递给 @tauri-apps/api/core 的 invoke；args 省略时以单参
 * 调用（不显式传 undefined）——mock 侧观测到的调用元数与迁移前各调用点
 * 直接持有 invoke 时完全一致。简单顺序流下 vi.mock(core) 拦截稳定；
 * 集中式动态导入在并发评估（前一次 import 未落定又发起同名导入，如
 * issue #802 的库变更通知重读与每资产队列下一操作同批发起）时会退化为
 * 原生导入绕过 mock——invoke 现以惰性单例持有动态导入（生产语义不变：
 * 模块本就按规范缓存），并发调用共享同一次评估，拦截失稳类随之消除；
 * 编排型集成测试（projectStore.tauri、useHomeActionFeedback）仍按原
 * 决定在本入口拦截，见各测试文件。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { IPC_COMMANDS } from './commands'
import { ipcInvoke } from './invoke'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => ({ cmd, args })),
}))

afterEach(() => vi.unstubAllGlobals())

describe('ipcInvoke 转发契约', () => {
  it('命令名与参数原样转发', async () => {
    await ipcInvoke(IPC_COMMANDS.savePrefs, { prefs: { a: 1 } })
    expect(invoke).toHaveBeenCalledWith('save_prefs', { prefs: { a: 1 } })
  })

  it('args 省略时以单参转发，不显式传 undefined', async () => {
    await ipcInvoke(IPC_COMMANDS.loadPrefs)
    expect(invoke).toHaveBeenCalledWith('load_prefs')
  })

  it('并发调用共享同一次动态导入评估，都经 mock 转发（issue #802）', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      calls += 1
      if (calls === 1) await held
      return { cmd }
    })
    const first = ipcInvoke(IPC_COMMANDS.loadPrefs)
    // 首次调用的动态导入尚未落定时并发发起第二次：不得退化为绕过
    // mock 的原生导入。
    const second = ipcInvoke(IPC_COMMANDS.savePrefs)
    release()
    await expect(first).resolves.toEqual({ cmd: 'load_prefs' })
    await expect(second).resolves.toEqual({ cmd: 'save_prefs' })
    expect(calls).toBe(2)
  })
})

/** Swift 宿主直达 typed IPC 时仍须保持原生能力不可用的可见失败。 */
describe('ipcInvoke 宿主边界', () => {
  it('Swift 有效桥执行生产命令，返回原生结果且不触及 Tauri', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: { native: true } })
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), {
        __pwNativeHost: { kind: 'swift', protocolVersion: 1, sessionId: 's1' },
        webkit: { messageHandlers: { plotweaveHost: { postMessage } } },
      }),
    )
    vi.mocked(invoke).mockClear()
    await expect(ipcInvoke(IPC_COMMANDS.loadPrefs)).resolves.toEqual({
      native: true,
    })
    expect(postMessage).toHaveBeenCalledOnce()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('Swift 的直接 IPC 调用拒绝，携带稳定错误码，不加载 Tauri 传输', async () => {
    vi.stubGlobal('window', { __pwNativeHost: { kind: 'swift' } })
    await expect(ipcInvoke(IPC_COMMANDS.loadPrefs)).rejects.toMatchObject({
      code: 'PW_HOST_COMMAND_UNAVAILABLE',
    })
  })
})
