/**
 * AI 对话通道（docs/ui-design.md §6）：OpenAI 兼容 chat completions。
 * 请求由 Rust 端 `ai_chat` 代理——API key 只在钥匙串与 Rust 内存中
 * 流转，不出后端（§8.2）；浏览器预览无 IPC，调用抛错由界面显示引导。
 * 首版非流式。命令型回复（改动预览卡的批次 JSON）走同一文本通道，
 * 解析与校验在 ai/commands.ts；执行前必须整批预览（数据模型 §12）。
 */
import type { ProviderConfig } from '../../settings/types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 发送一轮对话，返回助手回复文本。 */
export async function sendChat(
  provider: ProviderConfig,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string>('ai_chat', {
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    model,
    messages,
  })
}
