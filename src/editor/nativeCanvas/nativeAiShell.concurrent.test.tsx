// @vitest-environment happy-dom
/** #940：真实 React 调度和原生协议边界只向最后提交的 AI owner 交付命令。 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { startTransition, StrictMode, Suspense } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNativeAiShell, type NativeAiOptions } from './useNativeAiShell'
import {
  createRenderGate,
  type RenderGate,
} from '../concurrentRenderTestScaffolding'
import { validateAiBatch } from '../ai/batchFold'
import type { ThreadEntry } from '../../ai/session'
import * as nativeShell from '../../platform/nativeShell'

const host = window as Window & {
  __pwNativeHost?: unknown
  __pwNativeIntent?: (request: unknown) => Promise<unknown>
  webkit?: unknown
}
const gates: RenderGate[] = []
let sequence = 0

beforeEach(() => {
  host.__pwNativeHost = {
    kind: 'swift',
    protocolVersion: 1,
    sessionId: 'ai-owner-page',
  }
  host.webkit = { messageHandlers: { canvasHost: { postMessage: vi.fn() } } }
})
afterEach(async () => {
  cleanup()
  await act(async () => {
    for (const gate of gates) gate.release()
  })
  gates.length = 0
  delete host.__pwNativeHost
  delete host.webkit
  vi.restoreAllMocks()
})

/** 每次派发都有新协议身份，避免重复请求缓存掩盖 owner 变化。 */
function request(command: string, args: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    sessionId: 'ai-owner-page',
    requestId: `owner:${++sequence}`,
    command,
    args: { projectId: 'p', ...args },
  }
}

/** 走生产 dispatcher；卸载后的测试另外保留旧 dispatcher，验证其失效结果。 */
function intent(command: string, args: Record<string, unknown> = {}) {
  const dispatch = host.__pwNativeIntent
  if (!dispatch) throw new Error('Native AI dispatcher was not registered')
  return dispatch(request(command, args))
}

/** 协议回执之后才观察动作，避免把异步 admission 尚未执行误判为拒绝。 */
async function command(name: string, args: Record<string, unknown> = {}) {
  let result: unknown
  await act(async () => {
    result = await intent(name, args)
  })
  return result
}

/** 只注入动作接收者和只读快照，保留真实 hook、React 调度、协议及 reservation。 */
function options(context = vi.fn()): NativeAiOptions {
  return {
    projectId: 'p',
    models: {
      options: [
        {
          key: 'test:one',
          providerId: 'test',
          providerLabel: '测试',
          model: 'one',
        },
      ],
      activeKey: 'test:one',
      keyOkByProvider: { test: true },
      ready: true,
      setModelKey: vi.fn(),
    },
    messages: {
      thread: [],
      armedIdx: null,
      setArmedIdx: vi.fn(),
      executeCard: vi.fn(),
      markDismissed: vi.fn(),
      resetSession: vi.fn(),
    },
    turn: {
      busy: false,
      feedback: null,
      error: null,
      knowsCanvas: false,
      setKnowsCanvas: context,
      send: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn(),
      appendCancelReceipt: vi.fn(),
      clearError: vi.fn(),
    },
    saveError: null,
  }
}

/** Lazy 子树在 owner 完成 render 后挂起，使可见旧树与待提交新树明确分开。 */
function Owner({
  input,
  gate,
  pending,
}: {
  input: NativeAiOptions
  gate: RenderGate
  pending: boolean
}) {
  useNativeAiShell(input)
  const Gate = gate.Component
  return (
    <>
      <output data-testid="owner">{pending ? 'pending' : 'committed'}</output>
      {pending && <Gate />}
    </>
  )
}

/** 每个用例独占挂起 promise，StrictMode 配置不改变生产动作装配。 */
function fixture(strict: boolean, initial: NativeAiOptions) {
  const gate = createRenderGate()
  gates.push(gate)
  const tree = (input: NativeAiOptions, pending = false) => {
    const body = (
      <Suspense fallback={<p>loading</p>}>
        <Owner input={input} gate={gate} pending={pending} />
      </Suspense>
    )
    return strict ? <StrictMode>{body}</StrictMode> : body
  }
  const view = render(tree(initial))
  return {
    ...view,
    gate,
    show: (input: NativeAiOptions, pending = false) =>
      view.rerender(tree(input, pending)),
  }
}

it.each([false, true])(
  '挂起时只调用 A，B 提交后才调用 B，StrictMode=%s',
  async (strict) => {
    const committed = vi.fn()
    const pending = vi.fn()
    const a = options(committed)
    const b = options(pending)
    const h = fixture(strict, a)
    await act(async () => {
      startTransition(() => h.show(b, true))
    })
    expect(h.gate.wasRequested()).toBe(true)
    expect(screen.getByTestId('owner').textContent).toBe('committed')
    let result: unknown
    await act(async () => {
      result = await intent('ai.context', { enabled: true })
    })
    expect(result).toEqual({ ok: null })
    expect(committed).toHaveBeenCalledExactlyOnceWith(true)
    expect(pending).not.toHaveBeenCalled()
    await act(async () => {
      h.gate.release()
    })
    expect(screen.getByTestId('owner').textContent).toBe('pending')
    await act(async () => {
      await intent('ai.context', { enabled: false })
    })
    expect(pending).toHaveBeenCalledExactlyOnceWith(false)
    expect(committed).toHaveBeenCalledTimes(1)
  },
)

it.each([false, true])(
  '放弃 B 后仍调用 A，卸载使旧 dispatcher 失效，StrictMode=%s',
  async (strict) => {
    const committed = vi.fn()
    const pending = vi.fn()
    const a = options(committed)
    const h = fixture(strict, a)
    await act(async () => {
      startTransition(() => h.show(options(pending), true))
    })
    expect(h.gate.wasRequested()).toBe(true)
    act(() => h.show(a))
    await act(async () => {
      h.gate.release()
    })
    expect(screen.getByTestId('owner').textContent).toBe('committed')
    await act(async () => {
      await intent('ai.context', { enabled: true })
    })
    expect(committed).toHaveBeenCalledExactlyOnceWith(true)
    expect(pending).not.toHaveBeenCalled()
    const dispatch = host.__pwNativeIntent
    if (!dispatch) throw new Error('Native AI dispatcher was not registered')
    h.unmount()
    expect(
      await dispatch(request('ai.context', { enabled: false })),
    ).toMatchObject({ error: { code: 'PW_INTENT_UNAVAILABLE' } })
    expect(committed).toHaveBeenCalledTimes(1)
    expect(pending).not.toHaveBeenCalled()
  },
)

/** 每个发送由独立完成者控制，迟到回执不能释放后一个 reservation。 */
function pendingSend() {
  let finish!: () => void
  const promise = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { promise, finish }
}

it('提交新 options 不重置发送预留，取消后的旧完成不释放新发送', async () => {
  const first = pendingSend()
  const second = pendingSend()
  const a = options()
  const send = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
  a.turn.send = send
  const h = fixture(false, a)
  let firstResult: Promise<unknown> | undefined
  await act(async () => {
    firstResult = intent('ai.send', { text: 'first' })
  })
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  act(() => h.show({ ...a, turn: { ...a.turn } }))
  let rejected: unknown
  await act(async () => {
    rejected = await intent('ai.send', { text: 'duplicate' })
  })
  expect(rejected).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  expect(send).toHaveBeenCalledTimes(1)
  await act(async () => {
    await intent('ai.cancel')
  })
  expect(a.turn.cancel).toHaveBeenCalledTimes(1)
  expect(a.turn.appendCancelReceipt).toHaveBeenCalledTimes(1)
  let secondResult: Promise<unknown> | undefined
  await act(async () => {
    secondResult = intent('ai.send', { text: 'second' })
  })
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  await act(async () => {
    first.finish()
    await firstResult
  })
  await act(async () => {
    rejected = await intent('ai.send', { text: 'still-reserved' })
  })
  expect(rejected).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  expect(send).toHaveBeenCalledTimes(2)
  await act(async () => {
    second.finish()
    await secondResult
  })
})

it.each([undefined, null, 'true', 1])(
  '上下文命令拒绝非布尔值 %s',
  async (enabled) => {
    const input = options()
    fixture(false, input)
    expect(await command('ai.context', { enabled })).toMatchObject({
      error: { code: 'PW_INTENT_FAILED' },
    })
    expect(input.turn.setKnowsCanvas).not.toHaveBeenCalled()
  },
)

it.each([
  [undefined, true],
  ['missing', true],
  ['test:one', false],
] as const)(
  '模型选择拒绝未知或无 key 的模型 %s / key=%s',
  async (model, keyOk) => {
    const input = options()
    input.models.options = [
      {
        key: 'test:one',
        providerId: 'test',
        providerLabel: '测试',
        model: 'one',
      },
    ]
    input.models.keyOkByProvider = { test: keyOk }
    input.models.ready = keyOk
    fixture(false, input)
    expect(await command('ai.selectModel', { model })).toMatchObject({
      error: { code: 'PW_INTENT_FAILED' },
    })
    expect(input.models.setModelKey).not.toHaveBeenCalled()
  },
)

it.each([undefined, '', '  ', 42])(
  '发送拒绝空白或非文字输入 %s',
  async (text) => {
    const input = options()
    fixture(false, input)
    expect(await command('ai.send', { text })).toMatchObject({
      error: { code: 'PW_INTENT_FAILED' },
    })
    expect(input.turn.send).not.toHaveBeenCalled()
  },
)

it.each(['not-ready', 'busy'])(
  '发送拒绝不可接纳的 owner 状态 %s',
  async (state) => {
    const input = options()
    input.models.ready = state !== 'not-ready'
    if (state === 'not-ready') input.models.activeKey = null
    input.turn.busy = state === 'busy'
    fixture(false, input)
    expect(await command('ai.send', { text: '草稿' })).toMatchObject({
      error: { code: 'PW_INTENT_FAILED' },
    })
    expect(input.turn.send).not.toHaveBeenCalled()
  },
)

it('发送失败释放本次预留，显式重试可以成功', async () => {
  const input = options()
  input.turn.send = vi
    .fn()
    .mockRejectedValueOnce(new Error('transport failed'))
    .mockResolvedValue(undefined)
  fixture(false, input)
  expect(await command('ai.send', { text: 'first' })).toMatchObject({
    error: { code: 'PW_INTENT_FAILED' },
  })
  expect(await command('ai.send', { text: 'retry' })).toEqual({ ok: null })
  expect(input.turn.send).toHaveBeenCalledTimes(2)
})

it.each([false, true])(
  '取消只在 busy 或预留中写取消回执，busy=%s',
  async (busy) => {
    const input = options()
    input.turn.busy = busy
    fixture(false, input)
    expect(await command('ai.cancel')).toEqual({ ok: null })
    expect(input.turn.cancel).toHaveBeenCalledTimes(busy ? 1 : 0)
    expect(input.turn.appendCancelReceipt).toHaveBeenCalledTimes(busy ? 1 : 0)
  },
)

it.each([
  [false, false],
  [true, true],
] as const)('清空需要确认且不能处于 busy：%s / %s', async (confirmed, busy) => {
  const input = options()
  input.turn.busy = busy
  fixture(false, input)
  expect(await command('ai.clear', { confirmed })).toMatchObject({
    error: { code: 'PW_INTENT_FAILED' },
  })
  expect(input.turn.clearError).not.toHaveBeenCalled()
  expect(input.messages.resetSession).not.toHaveBeenCalled()
})

it('外来项目和未知动作不能调用当前 owner', async () => {
  const input = options()
  fixture(false, input)
  expect(
    await command('ai.context', { projectId: 'old', enabled: true }),
  ).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  expect(await command('ai.unknown')).toMatchObject({
    error: { code: 'PW_INTENT_FAILED' },
  })
  expect(input.turn.setKnowsCanvas).not.toHaveBeenCalled()
})

/** 预览形状来自生产批次校验，稳定 entry ID 与当前数组位置刻意不同。 */
function preview(destructive = false) {
  const input = options()
  const v = validateAiBatch(
    destructive
      ? [{ op: 'delete_node', nodeId: 'b' }]
      : [{ op: 'create_node', nodeType: 'beat', data: { name: '新节拍' } }],
    {
      nodes: [{ id: 'b', type: 'beat', label: '原节拍' }],
      edges: [],
      assets: new Map(),
    },
  )
  const card: NonNullable<ThreadEntry['card']> = { v, status: 'pending' }
  input.messages.thread = [
    { id: 1, kind: 'msg', role: 'user', text: '编辑节拍' },
    { id: 2, kind: 'msg', role: 'assistant', text: '预览', card },
  ]
  return { input, card }
}

it.each(['missing', 'not-a-card', 'executed', 'historical', 'busy', 'invalid'])(
  '执行拒绝失效或无效预览 %s',
  async (state) => {
    const { input, card } = preview()
    if (state === 'executed') card.status = 'executed'
    if (state === 'historical') card.historical = true
    if (state === 'busy') input.turn.busy = true
    if (state === 'invalid') card.v = { ...card.v, ok: false, commands: [] }
    fixture(false, input)
    expect(
      await command('ai.execute', {
        entryId: state === 'missing' ? 999 : state === 'not-a-card' ? 1 : 2,
      }),
    ).toMatchObject({
      error: {
        code: 'PW_INTENT_FAILED',
        message:
          state === 'invalid'
            ? '这批改动未通过验证。'
            : '这条改动已失效或正在执行。',
      },
    })
    expect(input.messages.executeCard).not.toHaveBeenCalled()
  },
)

it('确认武装按稳定 entry ID 解析当前位置，同一卡再次武装可取消', async () => {
  const { input } = preview(true)
  const h = fixture(false, input)
  expect(await command('ai.arm', { entryId: 2 })).toEqual({ ok: null })
  expect(input.messages.setArmedIdx).toHaveBeenLastCalledWith(1)
  act(() => h.show({ ...input, messages: { ...input.messages, armedIdx: 1 } }))
  expect(await command('ai.arm', { entryId: 2 })).toEqual({ ok: null })
  expect(input.messages.setArmedIdx).toHaveBeenLastCalledWith(null)
  expect(input.messages.executeCard).not.toHaveBeenCalled()
})

it.each(['ai.dismiss', 'ai.execute'])(
  '普通预览的 %s 交付当前数组位置',
  async (name) => {
    const { input } = preview()
    fixture(false, input)
    expect(await command(name, { entryId: 2 })).toEqual({ ok: null })
    expect(
      name === 'ai.dismiss'
        ? input.messages.markDismissed
        : input.messages.executeCard,
    ).toHaveBeenCalledExactlyOnceWith(1)
  },
)

it.each([null, 2, 1])(
  '删除预览只接受对应当前位置的武装 %s',
  async (armedIdx) => {
    const { input } = preview(true)
    input.messages.armedIdx = armedIdx
    fixture(false, input)
    const result = await command('ai.execute', { entryId: 2 })
    if (armedIdx === 1) expect(result).toEqual({ ok: null })
    else expect(result).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
    expect(input.messages.executeCard).toHaveBeenCalledTimes(
      armedIdx === 1 ? 1 : 0,
    )
  },
)

it.each([null, 1, 99])(
  '原生投影保留模型可用性并映射武装位置 %s',
  (armedIdx) => {
    const post = vi.fn()
    host.webkit = { messageHandlers: { canvasHost: { postMessage: post } } }
    const { input } = preview()
    input.messages.armedIdx = armedIdx
    input.models.options.push({
      key: 'disabled:two',
      providerId: 'disabled',
      providerLabel: '未配置',
      model: 'two',
    })
    input.models.keyOkByProvider.disabled = false
    input.turn.knowsCanvas = true
    input.turn.error = '回合错误'
    input.saveError = '未落盘'
    fixture(false, input)
    expect(post).toHaveBeenLastCalledWith({
      event: 'projection',
      protocolVersion: 1,
      sessionId: 'ai-owner-page',
      sequence: expect.any(Number),
      projection: {
        ai: {
          projectId: 'p',
          ready: true,
          model: 'test:one',
          models: [
            { value: 'test:one', label: '测试 · one', available: true },
            { value: 'disabled:two', label: '未配置 · two', available: false },
          ],
          busy: false,
          feedback: null,
          error: '回合错误',
          saveError: '未落盘',
          knowsCanvas: true,
          thread: JSON.parse(JSON.stringify(input.messages.thread)),
          armedEntryId: armedIdx === 1 ? 2 : null,
        },
      },
    })
  },
)

it('卸载后已交付注册层的旧动作回调也不能写入', async () => {
  const register = nativeShell.registerNativeIntentHandler
  let registered: Parameters<typeof register>[1] | undefined
  vi.spyOn(nativeShell, 'registerNativeIntentHandler').mockImplementation(
    (domain, handler) => {
      if (domain === 'ai') registered = handler
      return register(domain, handler)
    },
  )
  const input = options()
  const h = fixture(false, input)
  const previous = registered
  if (!previous) throw new Error('Native AI owner was not published')
  h.unmount()
  await expect(
    previous('ai.context', { projectId: 'p', enabled: true }),
  ).rejects.toThrow('AI 命令所属项目已关闭。')
  expect(input.turn.setKnowsCanvas).not.toHaveBeenCalled()
})

it('Web 挂载不安装原生 AI 命令或投影', () => {
  const post = vi.fn()
  delete host.__pwNativeHost
  host.webkit = { messageHandlers: { canvasHost: { postMessage: post } } }
  fixture(false, options())
  expect(host.__pwNativeIntent).toBeUndefined()
  expect(post).not.toHaveBeenCalled()
})
