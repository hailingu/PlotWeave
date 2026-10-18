// @vitest-environment happy-dom
/**
 * [issue #599](https://github.com/hailingu/PlotWeave/issues/599) 输入行
 * 发送按钮回归：Web/Tauri 的 AI 输入行除 Enter 外必须有可见的发送入口
 * （与原生壳一致）。禁用条件与 Enter 发送路径一致：未配置 provider 或
 * 空白草稿禁用；busy 态输入行切换为「取消」（issue #154）不渲染发送
 * 按钮，回合落定后恢复。仅替换外部 IPC 与设置读取，AiThread 组件、
 * 回合驱动与世代守卫保持真实。
 *
 * Key State And Invariant Matrix（输入行 × 发送入口）：
 * | 状态/前提 | 动作/过渡 | 可观测结果 | 不变量 | 验证 |
 * | --- | --- | --- | --- | --- |
 * | 已配置，空草稿 | 渲染输入行 | 「发送」可见但禁用，输入框可用 | 发送入口禁用条件与 Enter 路径 send() 守卫一致（空白文本不发） | 本文件 |
 * | 已配置，输入文本 | 点击「发送」 | 用户消息入列、llm_chat 发出、草稿清空 | 按钮与 Enter 走同一 onSend/turn.send，无双轨发送语义 | 本文件 |
 * | 已配置，输入文本 | 按 Enter | 同上 | Enter 发送保留（#599 修复不收窄键盘路径） | 本文件 |
 * | 未配置 provider | 渲染输入行 | 输入框与「发送」均禁用 | 未配置时无任何发送入口可触发请求 | 本文件 |
 * | busy（在途回合） | 输入行切换 | 仅「取消」，无「发送」；落定后恢复输入行与禁用态「发送」 | busy 语义由 useAiTurn 独占持有，按钮不引入并发发送 | 本文件 |
 *
 * 未覆盖维度：窄栏视觉与读屏实测属人工/实机验收（样式层以
 * flex 收缩契约保证按钮不被挤出视野，见 panels.css .pw-ai-input-row）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import type { AssistantMessage } from '../ai/chat'
import { settingsStore } from '../../settings/settingsStore'
import { stubElementScrollTo } from './testDomStubs'
import { AiThread } from './AiThread'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const invokeMock = vi.mocked(invoke)

/** 已配置 provider 的设置快照（keyEnc 存在即就绪，见 useAiModels）。 */
const CONFIGURED_SETTINGS = {
  providers: [
    {
      id: 'test',
      label: '测试服务',
      baseUrl: 'https://example.test/v1',
      enabled: true,
      models: ['test-model'],
      keyEnc: 'pw1:test-fixture',
    },
  ],
  defaultChat: 'test:test-model',
  defaultImage: null,
}

beforeEach(() => {
  stubElementScrollTo() // happy-dom 未实现 scrollTo
  invokeMock
    .mockReset()
    .mockResolvedValue({ role: 'assistant', content: '继续讨论。' })
  vi.spyOn(settingsStore, 'load').mockResolvedValue(CONFIGURED_SETTINGS)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const sendButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: '发送' }) as HTMLButtonElement

/** 等设置快照到达（ready 态输入框启用）后返回输入元素——输入框首帧即
 * 渲染，就绪信号是禁用解除，避免在 ready 前交互让 send() 静默 no-op。 */
async function composerInput(): Promise<HTMLInputElement> {
  const input = (await screen.findByLabelText(
    'AI 对话输入',
  )) as HTMLInputElement
  await waitFor(() => expect(input.disabled).toBe(false))
  return input
}

describe('AiThread 输入行发送按钮（issue #599）', () => {
  it('空草稿禁用；输入后启用；点击与 Enter 同效（用户消息入列并发出 llm_chat，草稿清空）', async () => {
    render(<AiThread projectId="p-composer" />)
    const input = await composerInput()
    expect(sendButton().disabled).toBe(true)

    fireEvent.change(input, { target: { value: '帮我丰富开场' } })
    expect(sendButton().disabled).toBe(false)

    fireEvent.click(sendButton())
    await waitFor(() => {
      screen.getByText('帮我丰富开场')
      expect(invokeMock).toHaveBeenCalledWith('llm_chat', expect.anything())
    })
    // 回合落定后输入行恢复且草稿已清空 → 发送回到禁用
    await waitFor(() => {
      expect(
        (screen.getByLabelText('AI 对话输入') as HTMLInputElement).value,
      ).toBe('')
      expect(sendButton().disabled).toBe(true)
    })
  })

  it('Enter 发送保留：与按钮共用同一回合路径', async () => {
    render(<AiThread projectId="p-composer" />)
    const input = await composerInput()
    fireEvent.change(input, { target: { value: '按 Enter 发送' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      screen.getByText('按 Enter 发送')
    })
    expect(invokeMock).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
    })
  })

  it('未配置 provider：输入框与发送按钮均禁用，不触发任何请求', async () => {
    vi.spyOn(settingsStore, 'load').mockResolvedValue({
      providers: [],
      defaultChat: null,
      defaultImage: null,
    })
    render(<AiThread projectId="p-composer" />)
    const input = (await screen.findByLabelText(
      'AI 对话输入',
    )) as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect(sendButton().disabled).toBe(true)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('空白草稿禁用发送（与 send() 的 trim 守卫一致）', async () => {
    render(<AiThread projectId="p-composer" />)
    const input = await composerInput()
    fireEvent.change(input, { target: { value: '   ' } })
    expect(sendButton().disabled).toBe(true)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('busy 态输入行切换为「取消」且无发送按钮；落定后恢复', async () => {
    // 非动词输入先经一次改写判定调用（issue #91）再进主对话：挂起全部
    // 调用的 resolver，busy 断言后统一放行并把后续调用切为自动应答。
    const pending: Array<(value: AssistantMessage) => void> = []
    invokeMock.mockImplementation(
      () =>
        new Promise<AssistantMessage>((resolve) => {
          pending.push(resolve)
        }),
    )
    render(<AiThread projectId="p-composer" />)
    const input = await composerInput()
    fireEvent.change(input, { target: { value: '长请求' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      screen.getByRole('button', { name: '取消' })
      expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
      expect(screen.queryByLabelText('AI 对话输入')).toBeNull()
    })

    invokeMock.mockImplementation(() =>
      Promise.resolve<AssistantMessage>({
        role: 'assistant',
        content: '完成了。',
      }),
    )
    await act(async () => {
      for (const resolve of pending.splice(0)) {
        resolve({ role: 'assistant', content: '完成了。' })
      }
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
      screen.getByLabelText('AI 对话输入')
      // 草稿随发送清空：恢复后的发送按钮回到禁用
      expect(sendButton().disabled).toBe(true)
    })
  })
})
