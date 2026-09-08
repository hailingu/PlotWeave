import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { llmChat, type AssistantMessage, type ChatMessage } from './chat'
import { runAgentLoop, type BatchValidators } from './agentLoop'
import type { BatchValidation, ValidatedCommand } from './commands'
import type { ProviderConfig } from '../../settings/types'
import type { ToolCall } from './tools'

/**
 * Agent 会话循环的编排语义（issue 41）：读工具就地回喂、写批次经
 * validate 整批校验、校验错误按通道回喂模型有限次重试；通过/耗尽/
 * 纯讨论即终止。llmChat 打桩，不触 IPC。
 */
vi.mock('./chat', () => ({ llmChat: vi.fn() }))
const llmChatMock = vi.mocked(llmChat)

afterEach(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  llmChatMock.mockReset()
})

const PROVIDER = { id: 'p', label: 'P', baseUrl: 'https://x/v1', enabled: true, models: ['m'] } as ProviderConfig

const reply = (over: Partial<AssistantMessage>): AssistantMessage => ({ role: 'assistant', content: null, ...over })

const batchCall = (commands: unknown[], id = 'w1'): ToolCall => ({
  id,
  type: 'function',
  function: { name: 'batch', arguments: JSON.stringify({ commands }) },
})

const okOf = (commands: ValidatedCommand[] = []): BatchValidation => ({
  ok: true,
  items: [],
  commands,
  issues: [],
  hasDeletes: false,
})

const failOf = (message: string): BatchValidation => ({
  ok: false,
  items: [],
  commands: [],
  issues: [{ index: 0, message }],
  hasDeletes: false,
})

const BAD_BEAT_BATCH = [
  { op: 'create_node', nodeType: 'beat', data: { label: '立足', summary: '小店开张', stakes: '能否站稳' } },
]
const GOOD_BEAT_BATCH = [{ op: 'create_node', nodeType: 'beat', data: { name: '立足', tone: '紧凑' } }]

/** 围栏批次回复：正文里带 ```json 批次。 */
const fenceReply = (commands: unknown[]): AssistantMessage =>
  reply({ content: `好的。\n\`\`\`json\n${JSON.stringify({ commands })}\n\`\`\`` } as Partial<AssistantMessage>)

const validators = (over: Partial<BatchValidators>): BatchValidators => ({ ...over })

const run = (messages: ChatMessage[], v: BatchValidators) =>
  runAgentLoop(PROVIDER, 'm', messages, () => 'SNAP', v)

describe('runAgentLoop 写批次校验闭环（issue 41）', () => {
  it('tool 通道：校验错误按 tool 协议回喂，纠正批次获得通过', async () => {
    const commands = vi
      .fn<NonNullable<BatchValidators['commands']>>()
      .mockReturnValueOnce(failOf('未知字段：label、summary、stakes（节奏卡 允许：name、tone、episodeNo）'))
      .mockReturnValueOnce(okOf())
    llmChatMock
      .mockResolvedValueOnce(reply({ tool_calls: [batchCall(BAD_BEAT_BATCH)] }))
      .mockResolvedValueOnce(reply({ content: '已修正', tool_calls: [batchCall(GOOD_BEAT_BATCH)] }))

    const messages: ChatMessage[] = [{ role: 'user', content: '创建节奏卡' }]
    const result = await run(messages, validators({ commands }))

    expect(llmChatMock).toHaveBeenCalledTimes(2)
    expect(result.validation?.ok).toBe(true)
    expect(result.prose).toBe('已修正')
    // 第二次请求按协议携带：失败的 assistant tool_calls + 每个调用的 tool 应答
    const second = llmChatMock.mock.calls[1][2]
    const assistant = second.find(
      (m) => m.role === 'assistant' && (m.tool_calls as unknown[] | undefined)?.length,
    )
    expect(assistant).toBeTruthy()
    const toolMsg = second.find((m) => m.role === 'tool')
    expect(toolMsg?.tool_call_id).toBe('w1')
    expect(toolMsg?.content).toContain('未知字段：label、summary、stakes')
    expect(toolMsg?.content).toContain('允许：name、tone、episodeNo')
  })

  it('校验通过即终止，不额外重问', async () => {
    const commands = vi.fn<NonNullable<BatchValidators['commands']>>().mockReturnValue(okOf())
    llmChatMock.mockResolvedValue(reply({ tool_calls: [batchCall(GOOD_BEAT_BATCH)] }))

    const result = await run([{ role: 'user', content: '创建节奏卡' }], validators({ commands }))

    expect(llmChatMock).toHaveBeenCalledTimes(1)
    expect(result.validation?.ok).toBe(true)
  })

  it('重试耗尽：有限次产出后保留最后一次校验失败', async () => {
    const commands = vi.fn<NonNullable<BatchValidators['commands']>>().mockReturnValue(failOf('未知字段：label'))
    llmChatMock.mockResolvedValue(reply({ tool_calls: [batchCall(BAD_BEAT_BATCH)] }))

    const result = await run([{ role: 'user', content: '创建节奏卡' }], validators({ commands }))

    expect(llmChatMock).toHaveBeenCalledTimes(3) // 首次 + 2 次纠错重试
    expect(commands).toHaveBeenCalledTimes(3)
    expect(result.validation?.ok).toBe(false)
    expect(result.validation?.issues[0]?.message).toBe('未知字段：label')
  })

  it('回喂完整问题清单：多错误批次一轮点名全部待修命令', async () => {
    const commands = vi
      .fn<NonNullable<BatchValidators['commands']>>()
      .mockReturnValueOnce({
        ok: false,
        items: [],
        commands: [],
        issues: [
          { index: 0, message: '未知字段：label' },
          { index: 1, message: '节点不存在：n9' },
          { index: 2, message: '端点不存在：a → b' },
        ],
        hasDeletes: false,
      })
      .mockReturnValueOnce(okOf())
    llmChatMock
      .mockResolvedValueOnce(reply({ tool_calls: [batchCall(BAD_BEAT_BATCH)] }))
      .mockResolvedValueOnce(reply({ content: '已全部修正', tool_calls: [batchCall(GOOD_BEAT_BATCH)] }))

    const result = await run([{ role: 'user', content: '改画布' }], validators({ commands }))

    expect(llmChatMock).toHaveBeenCalledTimes(2) // 清单完整 → 单轮修正即可通过
    expect(result.validation?.ok).toBe(true)
    const toolMsg = llmChatMock.mock.calls[1][2].find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('未知字段：label')
    expect(toolMsg?.content).toContain('节点不存在：n9')
    expect(toolMsg?.content).toContain('端点不存在：a → b')
  })

  it('围栏通道：校验错误以 user 消息回喂并重试，纠正后通过', async () => {
    const prose = vi
      .fn<NonNullable<BatchValidators['prose']>>()
      .mockReturnValueOnce(failOf('未知字段：label（节奏卡 允许：name、tone、episodeNo）'))
      .mockReturnValueOnce(okOf())
    llmChatMock
      .mockResolvedValueOnce(fenceReply(BAD_BEAT_BATCH))
      .mockResolvedValueOnce(fenceReply(GOOD_BEAT_BATCH))

    const messages: ChatMessage[] = [{ role: 'user', content: '创建节奏卡' }]
    const result = await run(messages, validators({ prose }))

    expect(llmChatMock).toHaveBeenCalledTimes(2)
    expect(result.validation?.ok).toBe(true)
    const second = llmChatMock.mock.calls[1][2]
    const users = second.filter((m) => m.role === 'user')
    const feedback = users[users.length - 1]
    expect(feedback?.content).toContain('未知字段：label')
    expect(feedback?.content).toContain('允许：name、tone、episodeNo')
    expect(feedback?.content).toContain('逐条修正')
  })

  it('非字段类校验失败：要求按错误清单逐条修正，不附带「保持不变」限定', async () => {
    const prose = vi
      .fn<NonNullable<BatchValidators['prose']>>()
      .mockReturnValueOnce(failOf('端点不存在：a → b'))
      .mockReturnValueOnce(okOf())
    llmChatMock
      .mockResolvedValueOnce(fenceReply(BAD_BEAT_BATCH))
      .mockResolvedValueOnce(fenceReply(GOOD_BEAT_BATCH))

    const messages: ChatMessage[] = [{ role: 'user', content: '连一下' }]
    const result = await run(messages, validators({ prose }))

    expect(llmChatMock).toHaveBeenCalledTimes(2)
    expect(result.validation?.ok).toBe(true)
    const second = llmChatMock.mock.calls[1][2]
    const users = second.filter((m) => m.role === 'user')
    const feedback = users[users.length - 1]
    expect(feedback?.content).toContain('端点不存在：a → b')
    // 字段限定语不得无条件出现：非字段错误（连线/引用类）若被要求
    // 「其余内容保持不变」，模型会原样保留非法命令直到耗尽重试
    expect(feedback?.content).not.toContain('其余内容保持不变')
  })

  it('纯讨论回复（无批次）立即终止，validation 为 null', async () => {
    const prose = vi.fn<NonNullable<BatchValidators['prose']>>().mockReturnValue(null)
    llmChatMock.mockResolvedValue(reply({ content: '建议先立冲突。' }))

    const result = await run([{ role: 'user', content: '怎么写？' }], validators({ prose }))

    expect(llmChatMock).toHaveBeenCalledTimes(1)
    expect(result.validation).toBeNull()
    expect(result.prose).toBe('建议先立冲突。')
    expect(prose).toHaveBeenCalledWith('建议先立冲突。')
  })
})

describe('runAgentLoop 读工具循环（既有行为保持）', () => {
  it('读调用就地回喂后重问，产出纯文本终止', async () => {
    const readTool = vi.fn(() => 'SNAP')
    llmChatMock
      .mockResolvedValueOnce(
        reply({
          tool_calls: [
            { id: 't1', type: 'function', function: { name: 'get_graph_snapshot', arguments: '{}' } },
          ],
        }),
      )
      .mockResolvedValueOnce(reply({ content: '画布为空。' }))

    const messages: ChatMessage[] = [{ role: 'user', content: '看看画布' }]
    const result = await runAgentLoop(PROVIDER, 'm', messages, readTool, validators({}))

    expect(readTool).toHaveBeenCalledWith('get_graph_snapshot', {})
    expect(llmChatMock).toHaveBeenCalledTimes(2)
    const toolMsg = llmChatMock.mock.calls[1][2].find((m) => m.role === 'tool')
    expect(toolMsg?.content).toBe('SNAP')
    expect(result).toMatchObject({ prose: '画布为空。', validation: null })
  })
})
