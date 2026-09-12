import { llmChat, type ChatMessage } from './chat'
import { ACTION_VERBS } from './actionIntent'
import type { ProviderConfig } from '../../settings/types'

/**
 * #91 的 query 改写通道：发送前用一次轻量模型调用把含糊请求归一化为
 * 规范动作描述，替代为口语动词（扩写、润色等）手工扩词表。改写只决定
 * 交付期待（是否进入有界纠正），不解析命令、不授予执行权限；失败或
 * 非动作回退 null，由调用方退回本地词表结果，回合照常进行。提示词与
 * actionIntent 的 ACTION_VERBS 同源，改写回复按整回复校验（须以规范动
 * 词开头）后才被采信。
 */

/** 与词表同源的改写提示词：动词只允许规范清单，非改动请求回复 NONE。 */
const REWRITE_SYSTEM = '判断用户的最新请求是否要求修改短剧画布（场景、节奏卡、' +
  '对白、分镜、连线、分支）或设定集（角色、地点、文档）。若是，只输出把动作动词' +
  `归一化后的中文请求本身，动词只能用：${ACTION_VERBS.join('、')}；` +
  '保留用户对目标的原始指称，不要回答、解释、执行或补充方案。否则只回复 NONE。'

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

/** 剥离改写回复的包装引号与句读后校验规范改写。改写输出属于不可信
 * 模型输出（PR #92 评审）：整回复校验——回复须以规范动词开头才算规范
 * 改写，NONE 标记与解释性混合回复都不是动词开头，一律按非动作回退，
 * 不做子串包含判定（目标文本含英文 None 时改写仍被采信，第四轮）。 */
export function parseRewrittenQuery(content: string | null): string | null {
  const text = trimWrapperChars((content ?? '').trim())
  return isCanonicalRewrite(text) ? text : null
}

function isCanonicalRewrite(text: string): boolean {
  return text !== '' && ACTION_VERBS.some((verb) => text.startsWith(verb))
}

/** 改写调用的独立短超时（PR #92 评审第四轮）：llm_chat 统一 120 秒超时，
 * 前置改写若同等等待，供应商挂起时会长时间阻塞主回合。 */
export const REWRITE_TIMEOUT_MS = 8_000

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
