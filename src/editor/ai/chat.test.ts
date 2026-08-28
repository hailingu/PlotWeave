import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '../../settings/types'
import type { AssistantMessage, ChatMessage } from './chat'

/** llm_chat IPC 协议形状：消息序列化裁剪与参数透传（§12.2）。 */

const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>()

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  vi.doMock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => invoke(...args),
  }))
  invoke.mockReset()
})

const provider: ProviderConfig = {
  id: 'openai',
  label: 'OpenAI 兼容',
  baseUrl: 'https://api.openai.com/v1',
  enabled: true,
  models: ['gpt-4o-mini'],
}

describe('llmChat（Rust 代理通道）', () => {
  it('命令与参数透传；返回 assistant message 原文', async () => {
    const reply: AssistantMessage = { role: 'assistant', content: '好的' }
    invoke.mockResolvedValueOnce(reply)
    const { llmChat } = await import('./chat')
    const got = await llmChat(provider, 'gpt-4o-mini', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '写一场戏' },
    ])
    expect(got).toBe(reply)
    const [cmd, args] = invoke.mock.calls[0] as [
      string,
      { providerId: string; baseUrl: string; model: string; messages: object[]; tools: unknown },
    ]
    expect(cmd).toBe('llm_chat')
    expect(args).toMatchObject({ providerId: 'openai', baseUrl: provider.baseUrl, model: 'gpt-4o-mini' })
    expect(args.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '写一场戏' },
    ])
  })

  it('消息序列化裁掉 undefined 字段；tool 消息保留 tool_call_id', async () => {
    invoke.mockResolvedValueOnce({ role: 'assistant', content: null })
    const { llmChat } = await import('./chat')
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
      { role: 'tool', content: '{}', tool_call_id: 'c1' },
    ]
    await llmChat(provider, 'm', messages)
    const args = invoke.mock.calls[0][1] as { messages: Array<Record<string, unknown>> }
    expect(Object.keys(args.messages[0])).toEqual(['role', 'content', 'tool_calls'])
    expect(args.messages[1]).toEqual({ role: 'tool', content: '{}', tool_call_id: 'c1' })
  })

  it('tools 缺省传 null；提供时原样透传', async () => {
    invoke.mockResolvedValue({ role: 'assistant', content: null })
    const { llmChat } = await import('./chat')
    await llmChat(provider, 'm', [{ role: 'user', content: 'hi' }])
    expect((invoke.mock.calls[0][1] as { tools: unknown }).tools).toBeNull()

    const tools = [{ type: 'function', function: { name: 'get_node', description: 'x', parameters: {} } }]
    await llmChat(provider, 'm', [{ role: 'user', content: 'hi' }], tools as never)
    expect((invoke.mock.calls[1][1] as { tools: unknown }).tools).toBe(tools)
  })
})
