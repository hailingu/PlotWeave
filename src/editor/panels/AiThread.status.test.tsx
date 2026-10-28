// @vitest-environment happy-dom
/**
 * #927 状态矩阵：useAiTurn 是生命周期 owner；两种界面消费同一反馈。
 * | 前提/转换 | 可见结果 | 不变量 | 验证 |
 * | 空会话 → 接受请求 → 长等待 | 等待回复 → 仍在等待 | 时间不能证明服务卡死 | 本文件 |
 * | 请求 → 文字/预览返回 | 回答结束；预览仍待确认 | 回答结束不执行改动 | 本文件 |
 * | 请求 → 错误 → 重发 | 失败原因和重发指引 → 等待 | 新轮清除旧错误 | 本文件 |
 * | 请求 → 取消 → 新轮 → 旧轮迟到 | 取消语义 → 新轮等待 | 旧轮不得清新轮状态 | 本文件 |
 * | 在途 → 卸载 → 认领 | 恢复原开始时间的等待 | 面板不拥有第二套请求 | 本文件 |
 * | 新会话/终态 → 新轮 | 清空/重新等待 | 旧计时器不得标记新轮长等待 | 本文件 |
 * IPC 桩只替换外部模型传输，组件、agentLoop、取消/认领保持生产实现。
 * 非流式通道无逐 token 生成事件，不声称模型持续活跃；原生实际控件另测。
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { settingsStore } from '../../settings/settingsStore'
import { AiThread } from './AiThread'
import { stubElementScrollTo } from './testDomStubs'
import type { AssistantMessage } from '../ai/chat'
import type { BatchValidation } from '../ai/commands'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const calls: Array<{
  resolve: (reply: AssistantMessage) => void
  reject: (error: Error) => void
}> = []
let project = 0

beforeEach(() => {
  stubElementScrollTo()
  calls.length = 0
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          calls.push({
            resolve: resolve as (reply: AssistantMessage) => void,
            reject,
          })
        }),
    )
  vi.spyOn(settingsStore, 'load').mockResolvedValue({
    providers: [
      {
        id: 'test',
        label: '测试',
        baseUrl: 'https://example.test/v1',
        enabled: true,
        models: ['model'],
        keyEnc: 'fixture',
      },
    ],
    defaultChat: 'test:model',
    defaultImage: null,
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Explicit discussion with an action word avoids the optional query-rewrite request. */
async function send(text = '不要修改画布，只讨论人物。') {
  const input = screen.getByLabelText('AI 对话输入') as HTMLInputElement
  if (input.disabled) await waitFor(() => expect(input.disabled).toBe(false))
  const before = calls.length
  fireEvent.change(input, { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  // Flush the asynchronous intent/transport boundary after fireEvent flushes its own updates.
  await act(async () => {
    await Promise.resolve()
  })
  expect(calls).toHaveLength(before + 1)
}

/** Install the owned clock before the request creates its waiting timer. */
async function useWaitingClock() {
  await waitFor(() =>
    expect(
      (screen.getByLabelText('AI 对话输入') as HTMLInputElement).disabled,
    ).toBe(false),
  )
  vi.useFakeTimers()
}

/** Completes one deterministic transport request while retaining the production reply parser. */
async function reply(index: number, content = '人物可以更果断。') {
  await act(async () => {
    calls[index]!.resolve({ role: 'assistant', content })
  })
}

it('accepted request remains readable through long wait and finishes with prose', async () => {
  render(<AiThread projectId={`status-${++project}`} />)
  expect(screen.queryByRole('status')).toBeNull()
  await useWaitingClock()
  await send()
  expect(screen.getByRole('status').textContent).toContain('正在等待 AI 回复')
  await act(async () => {
    vi.advanceTimersByTime(30_000)
  })
  expect(screen.getByRole('status').textContent).toContain('仍在等待 AI 回复')
  expect(screen.getByRole('status').textContent).toContain('取消')
  await reply(0)
  expect(screen.getByRole('status').textContent).toContain('本轮回答已结束')
  expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('false')
  expect(screen.getByText('人物可以更果断。')).toBeTruthy()
})

it('cancel/new send ignores late completion and old waiting timer', async () => {
  render(<AiThread projectId={`status-${++project}`} />)
  await useWaitingClock()
  await send()
  await act(async () => {
    vi.advanceTimersByTime(20_000)
  })
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(screen.getByRole('status').textContent).toContain('已停止本轮处理')
  expect(screen.getByRole('status').textContent).toContain(
    '在途服务请求可能仍会完成',
  )
  await send('不要修改画布，只讨论下一幕。')
  await reply(0, '旧轮迟到')
  await act(async () => {
    vi.advanceTimersByTime(10_000)
  })
  expect(screen.getByRole('status').textContent).toContain('正在等待 AI 回复')
  expect(screen.queryByText('旧轮迟到')).toBeNull()
  await reply(1)
})

it('failure exposes cause and recovery, and the next request replaces it', async () => {
  render(<AiThread projectId={`status-${++project}`} />)
  await send()
  await act(async () => {
    calls[0]!.reject(new Error('合成连接失败'))
  })
  expect(screen.getByRole('status').textContent).toContain('请求失败')
  expect(screen.getByRole('status').textContent).toContain('重新发送')
  expect(screen.getByText(/合成连接失败/)).toBeTruthy()
  await send()
  expect(screen.getByRole('status').textContent).toContain('正在等待 AI 回复')
  expect(screen.queryByText(/合成连接失败/)).toBeNull()
  await reply(1)
})

it('remount claims the waiting turn with its original long-wait threshold', async () => {
  const id = `status-${++project}`
  const view = render(<AiThread projectId={id} />)
  await useWaitingClock()
  await send()
  await act(async () => {
    vi.advanceTimersByTime(20_000)
  })
  view.unmount()
  render(<AiThread projectId={id} />)
  await act(async () => {
    vi.advanceTimersByTime(10_000)
  })
  expect(screen.getByRole('status').textContent).toContain('仍在等待 AI 回复')
  await reply(0)
  expect(screen.getByRole('status').textContent).toContain('本轮回答已结束')
})

it('a validated preview ends waiting without executing the batch', async () => {
  const onApplyAiBatch = vi.fn()
  const validation: BatchValidation = {
    ok: true,
    commands: [
      { op: 'create_node', nodeType: 'beat', data: { name: '待确认节拍' } },
    ],
    items: [{ kind: 'create', key: '0', label: '创建节拍', danger: false }],
    issues: [],
    hasDeletes: false,
  }
  render(
    <AiThread
      projectId={`status-${++project}`}
      onValidateAi={() => validation}
      onApplyAiBatch={onApplyAiBatch}
    />,
  )
  await send()
  await reply(0, '这里是待确认的方案。')
  expect(screen.getByRole('status').textContent).toContain('本轮回答已结束')
  expect(screen.getByRole('status').textContent).toContain('确认')
  expect(screen.getByRole('button', { name: /执行/ })).toBeTruthy()
  expect(onApplyAiBatch).not.toHaveBeenCalled()
})

it('new session clears terminal feedback and a following turn starts normally', async () => {
  render(<AiThread projectId={`status-${++project}`} />)
  await send()
  await reply(0)
  fireEvent.click(screen.getByRole('button', { name: '新会话' }))
  fireEvent.click(screen.getByRole('button', { name: '再点一次确认清空' }))
  expect(screen.queryByRole('status')).toBeNull()
  await send()
  expect(screen.getByRole('status').textContent).toContain('正在等待 AI 回复')
  await reply(1)
})

it('a claimed failure ends waiting and retains the actual error', async () => {
  const id = `status-${++project}`
  const view = render(<AiThread projectId={id} />)
  await send()
  view.unmount()
  render(<AiThread projectId={id} />)
  expect(screen.getByRole('status').textContent).toContain('正在等待 AI 回复')
  await act(async () => {
    calls[0]!.reject(new Error('认领回合连接失败'))
  })
  expect(screen.getByRole('status').textContent).toContain('请求失败')
  expect(screen.getByText(/认领回合连接失败/)).toBeTruthy()
})
