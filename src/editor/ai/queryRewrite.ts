import { llmChat, type ChatMessage } from './chat'
import { ACTION_VERBS } from './actionIntent'
import type { ProviderConfig } from '../../settings/types'

/**
 * #91 的 query 改写通道：发送前用一次轻量模型调用把含糊请求归一化为
 * 规范动作描述，替代为口语动词（扩写、润色等）手工扩词表。改写只决定
 * 交付期待（是否进入有界纠正），不解析命令、不授予执行权限；失败或
 * 非动作回退 null，由调用方退回本地词表结果，回合照常进行。提示词与
 * actionIntent 的 ACTION_VERBS 同源；回复为结构化 JSON 并按整回复校验
 * 后才被采信（PR #92 评审：文本协议无法区分分类标记与含 NONE/动词的
 * 目标原文，结构化格式消除该混淆）。
 */

/** 与词表同源的改写提示词：只输出协议 JSON，动词只允许规范清单。 */
const REWRITE_SYSTEM = '判断用户的最新请求是否要求修改短剧画布（场景、节奏卡、' +
  '对白、分镜、连线、分支）或设定集（角色、地点、文档）。只输出一个 JSON 对象，' +
  '不要输出任何其他文字：要求修改时输出 {"action":true,"query":"<归一化后的中文' +
  '规范请求>"}，query 以动词 ' + ACTION_VERBS.join('、') + ' 之一开头，保留用户对' +
  '目标的原始指称；其余情况（提问、讨论、寒暄、明确暂不操作）输出 {"action":false}。'

/** 改写调用的独立短超时（PR #92 评审第四轮）：llm_chat 统一 120 秒超时，
 * 前置改写若同等等待，供应商挂起时会长时间阻塞主回合。 */
export const REWRITE_TIMEOUT_MS = 8_000

/** 改写回复常见的包装字符：引号与中英文句读，两端成对剥离（线性扫描，
 * 不用正则——SonarQube S8786 对 `[…]+$` 形态报超线性回溯）。 */
const WRAPPER_CHARS = '"\'`「」『』。，,．.、！!？?；;：:'

function trimWrapperChars(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && WRAPPER_CHARS.includes(text.charAt(start))) start += 1
  while (end > start && WRAPPER_CHARS.includes(text.charAt(end - 1))) end -= 1
  return text.slice(start, end)
}

/** 提示词要求裸 JSON，仍宽容 ```json 围栏包装（模型常见偏离）。 */
function unwrapJsonText(content: string): string {
  if (!content.startsWith('```')) return content
  const start = content.indexOf('\n')
  const end = content.lastIndexOf('```')
  return start !== -1 && end > start ? content.slice(start + 1, end) : ''
}

/** 解析并校验改写回复。改写输出属于不可信模型输出（PR #92 评审）：
 * 回复须是协议 JSON——{"action":true,"query":"…"} 且 query 以规范动词
 * 开头（与词表同源）才采信；分类标记、解释文字、非动词开头或坏 JSON
 * 一律按非动作回退 null。先剥 ```json 围栏再剥包装字符（反引号属于
 * 后者的字符集，顺序相反会吃掉闭合围栏）。 */
export function parseRewrittenQuery(content: string | null): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(trimWrapperChars(unwrapJsonText((content ?? '').trim())))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { action, query } = parsed as { action?: unknown; query?: unknown }
  if (action !== true || typeof query !== 'string') return null
  const canonical = trimWrapperChars(query.trim())
  return canonical !== '' && ACTION_VERBS.some((verb) => canonical.startsWith(verb))
    ? canonical
    : null
}

/** 改写一轮用户请求；llmChat 是唯一 I/O。传输失败或超时回退 null，不向
 * 回合抛出；超时后迟到的改写结果被丢弃，主回合照常开始。 */
export async function rewriteActionQuery(
  provider: ProviderConfig,
  model: string,
  text: string,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    { role: 'system', content: REWRITE_SYSTEM },
    { role: 'user', content: text },
  ]
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), REWRITE_TIMEOUT_MS)
  })
  try {
    const reply = await Promise.race([llmChat(provider, model, messages), timeout])
    return reply ? parseRewrittenQuery(reply.content) : null
  } catch {
    // 改写是尽力而为的归一化步骤，传输失败按未识别处理（issue 91 回退语义）。
    return null
  } finally {
    clearTimeout(timer)
  }
}
