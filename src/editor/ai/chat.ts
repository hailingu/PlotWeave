/**
 * LLM 对话通道（docs/ui-design.md §6、数据模型 §12.2 tool-calling 循环）。
 * 请求由 Rust 端 `llm_chat` 代理——API key 只在钥匙串与 Rust 内存中流转，
 * 不出后端（§8.2）；浏览器预览无 IPC，调用抛错由界面显示引导。
 * 非流式；tools 为 OpenAI 兼容工具定义（可缺省），返回 assistant message
 * 原文（content + 可选 tool_calls），写调用映射为预览卡命令、读调用就地回喂。
 */
import type { ProviderConfig } from '../../settings/types'
import type { ToolSpec } from './tools'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** role = 'tool' 时回喂对应的 tool_call id。 */
  tool_call_id?: string
  /** assistant 原始消息（含 tool_calls）在循环内透传时挂载。 */
  tool_calls?: unknown
}

export interface AssistantMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

/** 发送一轮对话，返回 assistant message（含可选 tool_calls）。 */
export async function llmChat(
  provider: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  tools?: ToolSpec[],
): Promise<AssistantMessage> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<AssistantMessage>('llm_chat', {
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    model,
    messages: messages.map(({ role, content, tool_call_id, tool_calls }) => ({
      role,
      content,
      ...(tool_call_id !== undefined ? { tool_call_id } : {}),
      ...(tool_calls !== undefined ? { tool_calls } : {}),
    })),
    tools: tools ?? null,
  })
}
