// @vitest-environment happy-dom
/** Swift 宿主协议 v1：会话隔离、单请求回执与结果未知边界。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_COMMANDS } from '../ipc/commands'
import { invokeSwiftHost } from './swiftHost'

let postMessage = vi.fn()

beforeEach(() => {
  postMessage = vi.fn().mockResolvedValue({ ok: { saved: true } })
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      __pwNativeHost: {
        kind: 'swift',
        protocolVersion: 1,
        sessionId: 'session-a',
      },
      webkit: { messageHandlers: { plotweaveHost: { postMessage } } },
    }),
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Swift 命令桥', () => {
  it('成功回执解包，命令请求带协议、会话和唯一请求身份', async () => {
    await expect(
      invokeSwiftHost(IPC_COMMANDS.savePrefs, { prefs: {} }),
    ).resolves.toEqual({ saved: true })
    await invokeSwiftHost(IPC_COMMANDS.loadPrefs)
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject({
      protocolVersion: 1,
      sessionId: 'session-a',
      command: 'save_prefs',
      args: { prefs: {} },
    })
    expect(postMessage.mock.calls[0]?.[0].requestId).not.toBe(
      postMessage.mock.calls[1]?.[0].requestId,
    )
    expect(postMessage.mock.calls[1]?.[0]).not.toHaveProperty('args')
  })

  it('后端结构化拒绝保留机器码与消息，没有自动重试', async () => {
    postMessage.mockResolvedValue({
      error: { code: 'PW_STORE_IO', message: 'disk unavailable' },
    })
    await expect(invokeSwiftHost(IPC_COMMANDS.savePrefs)).rejects.toMatchObject(
      { code: 'PW_STORE_IO', message: 'disk unavailable' },
    )
    expect(postMessage).toHaveBeenCalledOnce()
  })

  it.each([
    { ok: 1, error: { code: 'x', message: 'y' } },
    {},
    { error: 'failed' },
  ])('非法回执 %j 不会伪造成功', async (reply) => {
    postMessage.mockResolvedValue(reply)
    await expect(invokeSwiftHost(IPC_COMMANDS.loadPrefs)).rejects.toMatchObject(
      { code: 'PW_HOST_PROTOCOL_INVALID' },
    )
  })

  it('协议版本错误时不发送请求', async () => {
    Object.assign(window, {
      __pwNativeHost: {
        kind: 'swift',
        protocolVersion: 2,
        sessionId: 'session-a',
      },
    })
    await expect(invokeSwiftHost(IPC_COMMANDS.loadPrefs)).rejects.toMatchObject(
      { code: 'PW_HOST_COMMAND_UNAVAILABLE' },
    )
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('未回执超时结果未知，迟到成功不能改写失败', async () => {
    vi.useFakeTimers()
    let reply!: (value: unknown) => void
    postMessage.mockReturnValue(
      new Promise((resolve) => {
        reply = resolve
      }),
    )
    const result = invokeSwiftHost(IPC_COMMANDS.savePrefs)
    const rejected = expect(result).rejects.toMatchObject({
      code: 'PW_HOST_TIMEOUT',
      outcomeUnknown: true,
    })
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    reply({ ok: null })
    expect(postMessage).toHaveBeenCalledOnce()
  })

  it('页面结束拒绝在途请求，重载不等待旧请求', async () => {
    postMessage.mockReturnValue(new Promise(() => {}))
    const result = invokeSwiftHost(IPC_COMMANDS.savePrefs)
    window.dispatchEvent(new Event('pagehide'))
    await expect(result).rejects.toMatchObject({
      code: 'PW_HOST_SESSION_ENDED',
      outcomeUnknown: true,
    })
  })

  it('会话切换后的旧回执不能落到新会话', async () => {
    let reply!: (value: unknown) => void
    postMessage.mockReturnValue(
      new Promise((resolve) => {
        reply = resolve
      }),
    )
    const result = invokeSwiftHost(IPC_COMMANDS.loadPrefs)
    Object.assign(window, {
      __pwNativeHost: {
        kind: 'swift',
        protocolVersion: 1,
        sessionId: 'session-b',
      },
    })
    reply({ ok: 'old' })
    await expect(result).rejects.toMatchObject({
      code: 'PW_HOST_SESSION_ENDED',
      outcomeUnknown: true,
    })
  })
})

it.each(['throw', 'reject'] as const)(
  '发送口 %s 失败保留结果未知且不自动重试',
  async (mode) => {
    if (mode === 'throw')
      postMessage.mockImplementation(() => {
        throw new Error('transport unavailable')
      })
    else postMessage.mockRejectedValue(new Error('transport unavailable'))
    await expect(invokeSwiftHost(IPC_COMMANDS.savePrefs)).rejects.toMatchObject(
      { code: 'PW_HOST_TRANSPORT_FAILED', outcomeUnknown: true },
    )
    expect(postMessage).toHaveBeenCalledOnce()
  },
)

it('WithReply 发送口返回非 Promise 时仍拒绝违反传输合同的结果', async () => {
  // SwiftMessageHandler.postMessage requires a Promise, not an immediate envelope.
  postMessage.mockReturnValue({ ok: null })
  await expect(invokeSwiftHost(IPC_COMMANDS.savePrefs)).rejects.toMatchObject({
    code: 'PW_HOST_TRANSPORT_FAILED',
    outcomeUnknown: true,
  })
  expect(postMessage).toHaveBeenCalledOnce()
})

it.each([
  [IPC_COMMANDS.llmChat, 150_000],
  [IPC_COMMANDS.llmImageGenerate, 660_000],
] as const)('模型命令 %s 使用完整内核预算', async (command, budget) => {
  vi.useFakeTimers()
  postMessage.mockReturnValue(new Promise(() => {}))
  let ended = false
  const result = invokeSwiftHost(command)
  const rejected = expect(result).rejects.toMatchObject({
    code: 'PW_HOST_TIMEOUT',
  })
  void result.catch(() => {
    ended = true
  })
  await vi.advanceTimersByTimeAsync(budget - 1)
  expect(ended).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await rejected
})

it('系统保存面板等待用户，无自动超时；页面结束仍拒绝', async () => {
  vi.useFakeTimers()
  postMessage.mockReturnValue(new Promise(() => {}))
  let ended = false
  const result = invokeSwiftHost('system.saveText', {
    text: 'text',
    fileName: 'text.md',
  })
  const rejected = expect(result).rejects.toMatchObject({
    code: 'PW_HOST_SESSION_ENDED',
  })
  void result.catch(() => {
    ended = true
  })
  await vi.advanceTimersByTimeAsync(600_000)
  expect(ended).toBe(false)
  window.dispatchEvent(new Event('pagehide'))
  await rejected
})

it('乱序完成只落定对应请求，不串用结果', async () => {
  const replies: Array<(value: unknown) => void> = []
  postMessage.mockImplementation(
    () =>
      new Promise((resolve) => {
        replies.push(resolve)
      }),
  )
  const first = invokeSwiftHost(IPC_COMMANDS.loadPrefs)
  const second = invokeSwiftHost(IPC_COMMANDS.listProjects)
  replies[1]?.({ ok: 'projects' })
  replies[0]?.({ ok: 'prefs' })
  await expect(first).resolves.toBe('prefs')
  await expect(second).resolves.toBe('projects')
})
