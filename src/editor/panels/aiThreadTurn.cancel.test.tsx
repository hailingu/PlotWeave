// @vitest-environment happy-dom
/**
 * useAiTurn 取消语义（issue #154）：busy 时暴露 cancel；取消立即可发下一轮；
 * 迟到结果被世代守卫丢弃，不覆盖新轮次、不误形成预览；取消以「已取消」
 * note 回执保留在会话中；导航卸载（#63）后迟到的已取消结果不上屏、不复活。
 * runModelTurn 打桩，不触 IPC。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useAiTurn, type UseAiTurnOpts } from './aiThreadTurn'
import { runModelTurn } from './aiThreadModel'
import { takeTurn, type TurnBox } from '../ai/pendingTurns'
import { TurnCancelledError } from '../ai/agentLoop'
import type { ThreadEntry } from '../ai/session'
import type { ProviderConfig } from '../../settings/types'

vi.mock('./aiThreadModel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./aiThreadModel')>()
  return { ...actual, runModelTurn: vi.fn() }
})
const runModelTurnMock = vi.mocked(runModelTurn)

afterEach(cleanup)
beforeEach(() => {
  runModelTurnMock.mockReset()
})

const provider = {
  id: 'p',
  label: 'P',
  baseUrl: 'https://x/v1',
  enabled: true,
  models: ['m'],
} as unknown as ProviderConfig
const option = { key: 'p:m', providerId: 'p', model: 'm', providerLabel: 'P' }

/** 可手动决回合的 runModelTurn 桩：返回延迟控制器与调用记录。 */
function pendingTurn() {
  const calls: Array<{
    resolve: (entries: ThreadEntry[]) => void
    reject: (err: unknown) => void
    signal?: { isCancelled(): boolean }
  }> = []
  runModelTurnMock.mockImplementation(
    (_p, _m, _msgs, _read, _validators, _nextId, signal) =>
      new Promise<ThreadEntry[]>((resolve, reject) => {
        calls.push({ resolve, reject, signal })
      }),
  )
  return calls
}

/** 自增条目 id 生成器（每次 mkOpts 独立）。 */
function idGen() {
  let n = 0
  return () => ++n
}

let pid = 0
function mkOpts(over: Partial<UseAiTurnOpts> = {}): UseAiTurnOpts {
  return {
    projectId: 'p-cancel-' + ++pid,
    activeOption: option,
    activeProvider: provider,
    thread: [],
    append: vi.fn(),
    nextId: idGen(),
    setArmedIdx: vi.fn(),
    ...over,
  }
}

/** 发起 send（async act 驱动到 await 边界：runModelTurn 已调用、回合在途）。 */
async function startSend(result: { current: ReturnType<typeof useAiTurn> }) {
  await act(async () => {
    void result.current.send()
  })
}

describe('useAiTurn 取消（issue #154）', () => {
  it('busy 时暴露 cancel；取消置 signal；回执由取消路径立即上屏', async () => {
    const calls = pendingTurn()
    const append = vi.fn()
    const { result } = renderHook(() => useAiTurn(mkOpts({ append })))

    expect(result.current.busy).toBe(false)
    act(() => {
      result.current.setDraft('你好')
    })
    await startSend(result)
    expect(result.current.busy).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.signal?.isCancelled()).toBe(false)
    // busy 时暴露取消入口
    expect(result.current.cancel).toBeTypeOf('function')

    // 取消：signal 立即使 agentLoop 协作式退出；回执由取消路径上屏
    act(() => {
      result.current.cancel()
      result.current.appendCancelReceipt()
    })
    expect(calls[0]!.signal?.isCancelled()).toBe(true)
    expect(append).toHaveBeenCalledWith([
      { id: expect.any(Number), kind: 'note', text: '已取消' },
    ])
    expect(result.current.busy).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('取消后立即可发下一轮；迟到的旧结果被世代守卫丢弃，不覆盖新轮次', async () => {
    const calls = pendingTurn()
    const append = vi.fn()
    const { result } = renderHook(() => useAiTurn(mkOpts({ append })))

    act(() => {
      result.current.setDraft('你好')
    })
    await startSend(result)
    await waitFor(() => expect(result.current.busy).toBe(true))
    // 取消本轮（回执立即上屏）
    act(() => {
      result.current.cancel()
      result.current.appendCancelReceipt()
    })
    expect(result.current.busy).toBe(false)
    expect(append).toHaveBeenCalledWith([
      { id: expect.any(Number), kind: 'note', text: '已取消' },
    ])

    // 立即发下一轮
    act(() => {
      result.current.setDraft('继续')
    })
    act(() => {
      result.current.setDraft('你好')
    })
    await startSend(result)
    expect(calls).toHaveLength(2)
    expect(result.current.busy).toBe(true)

    // 旧轮迟到结果（新轮在途时才落定）：被守卫丢弃，不覆盖新轮次、不形成预览
    await act(async () => {
      calls[0]!.resolve([
        { id: 901, kind: 'msg', role: 'assistant', text: '旧轮迟到回复' },
      ])
    })
    expect(result.current.busy).toBe(true)
    const appendedBeforeNew = append.mock.calls
      .map((c) => c[0] as ThreadEntry[])
      .flat()
      .map((e) => e.text)
    expect(appendedBeforeNew).not.toContain('旧轮迟到回复')

    // 新轮正常落定
    await act(async () => {
      calls[1]!.resolve([
        { id: 902, kind: 'msg', role: 'assistant', text: '新轮回复' },
      ])
    })
    await waitFor(() => expect(result.current.busy).toBe(false))
    const appendedAfterNew = append.mock.calls
      .map((c) => c[0] as ThreadEntry[])
      .flat()
      .map((e) => e.text)
    expect(appendedAfterNew).toContain('新轮回复')
  })

  it('取消错误（TurnCancelledError）映射为取消回执而非错误横幅', async () => {
    runModelTurnMock.mockRejectedValue(new TurnCancelledError())
    const append = vi.fn()
    const { result } = renderHook(() => useAiTurn(mkOpts({ append })))

    act(() => {
      result.current.setDraft('你好')
    })
    await startSend(result)
    await waitFor(() => expect(result.current.busy).toBe(false))
    expect(result.current.error).toBeNull()
    expect(append).toHaveBeenCalledWith([
      { id: expect.any(Number), kind: 'note', text: '已取消' },
    ])
  })

  it('卸载后（#63 导航）迟到的已取消结果不上屏、不复活旧轮', async () => {
    const calls = pendingTurn()
    const append = vi.fn()
    const opts = mkOpts({ append })
    const { result, unmount } = renderHook(() => useAiTurn(opts))

    act(() => {
      result.current.setDraft('你好')
    })
    await startSend(result)
    await waitFor(() => expect(result.current.busy).toBe(true))
    act(() => result.current.cancel())
    unmount()
    await act(async () => {
      calls[0]!.resolve([{ id: 950, kind: 'note', text: '已取消' }])
    })
    // 发起实例已卸载：仅用户消息在发送时已入列；迟到结果不上屏、不复活
    const appended = append.mock.calls
      .map((c) => c[0] as ThreadEntry[])
      .flat()
      .map((e) => e.text)
    expect(appended).toEqual(['你好'])
    // 取消后注销注册表：重开不再认领到已取消的盒子（PR #187 评审 4024585104）
    expect(takeTurn(opts.projectId)).toBeNull()
  })

  it('取消后在途请求 reject（错误形状）：仍注销盒子，重开不复活陈旧失败（PR #187 评审 4024818105）', async () => {
    const calls = pendingTurn()
    const append = vi.fn()
    const opts = mkOpts({ append })
    const { result, unmount } = renderHook(() => useAiTurn(opts))

    act(() => {
      result.current.setDraft('你好')
    })
    await startSend(result)
    await waitFor(() => expect(result.current.busy).toBe(true))
    act(() => result.current.cancel())
    unmount()
    // 在途请求先 reject（runAgentLoop 在 post-request 取消检查前传播 rejection），
    // 结果为错误形状而非取消形状
    await act(async () => {
      calls[0]!.reject(new Error('网络中断'))
    })
    // 发起实例已卸载：不上屏错误；被取代的盒子仍注销，重开不复活陈旧失败
    const appended = append.mock.calls
      .map((c) => c[0] as ThreadEntry[])
      .flat()
      .map((e) => e.text)
    expect(appended).toEqual(['你好'])
    expect(takeTurn(opts.projectId)).toBeNull()
  })

  it('取消的盒子带 canceller：认领方据此停止旧轮（PR #187 评审 4024585097）', async () => {
    const calls = pendingTurn()
    const append = vi.fn()
    const opts = mkOpts({ append })
    const first = renderHook(() => useAiTurn(opts))
    act(() => {
      first.result.current.setDraft('你好')
    })
    await startSend(first.result)
    await waitFor(() => expect(first.result.current.busy).toBe(true))
    // 模拟导航卸载，盒子留在注册表
    first.unmount()
    const box = takeTurn(opts.projectId)
    expect(box).not.toBeNull()
    // 取消路径产出的盒子暴露 canceller，认领方可停止旧轮
    const settled = Promise.resolve({
      entries: [{ id: 960, kind: 'note' as const, text: '已取消' }],
      error: null,
    })
    const cancelBox: TurnBox = {
      promise: settled,
      canceller: () =>
        calls[0]!.signal && (calls[0]!.signal.isCancelled = () => true),
    }
    cancelBox.canceller?.()
    expect(calls[0]!.signal?.isCancelled()).toBe(true)
    void calls
  })
})
