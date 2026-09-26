/**
 * 助手回复文本中的批次 JSON 提取（commands.ts 拆分，数据模型 §12.2
 * 围栏回退通道）：优先取最后一个 ```json 围栏，其次裸
 * `{"commands":[...]}` 前缀。纯文本解析，不触碰命令校验——解析出的
 * commands 交给 validateAiBatch 做入站信任边界校验。
 */

/** 取最后一个 ```json 围栏的正文；无闭合围栏返回 null。
 * 用 indexOf 线性扫描等价替代 /```json\s*([\s\S]*?)```/gi 的惰性匹配，
 * 消除超线性回溯（SonarQube S8786）；大小写不敏感与「取最后一个」
 * 语义由 extractBatchJson 测试钉住。标记大小写不敏感按码元逐段比较，
 * 避免 toLowerCase 改变字符串长度导致下标漂移（如 İ）。 */
function lastFenceBody(text: string): string | null {
  let last: string | null = null
  let from = 0
  for (;;) {
    const open = text.indexOf('```', from)
    if (open === -1) break
    const afterTicks = open + 3
    if (text.slice(afterTicks, afterTicks + 4).toLowerCase() !== 'json') {
      from = afterTicks
      continue
    }
    let bodyStart = afterTicks + 4
    // 越界字符（undefined）显式判非空白（issue #230）：与循环边界守卫一致
    while (bodyStart < text.length) {
      const ch = text[bodyStart]
      if (ch === undefined || !/\s/.test(ch)) break
      bodyStart++
    }
    const close = text.indexOf('```', bodyStart)
    if (close === -1) break // 之后不再有 ```，自然也不再有可闭合的围栏
    last = text.slice(bodyStart, close)
    from = close + 3
  }
  return last
}

function isBatchShape(v: unknown): v is { commands: unknown[] } {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { commands?: unknown }).commands)
  )
}

/** 解析回复文本中的批次对象；无法解析返回 undefined（纯讨论回复）。 */
export function extractBatchJson(
  text: string,
): { commands: unknown[] } | undefined {
  const last = lastFenceBody(text)
  const candidates: string[] = []
  if (last !== null) candidates.push(last)
  const trimmed = text.trim()
  if (trimmed.startsWith('{"commands"')) candidates.push(trimmed)
  for (const raw of candidates) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isBatchShape(parsed)) return parsed
    } catch {
      // 继续尝试下一个候选
    }
  }
  return undefined
}

/** 未闭合 ```json 围栏的正文（最后一个 ``` 开标记无闭合时其后的剩余
 * 文本）：截断或漏写闭合围栏的呈交形态。最后一个开标记非 JSON、或无
 * 未闭合围栏时返回 null。 */
function pendingFenceBody(text: string): string | null {
  let from = 0
  for (;;) {
    const open = text.indexOf('```', from)
    if (open === -1) return null
    const afterTicks = open + 3
    const isJson =
      text.slice(afterTicks, afterTicks + 4).toLowerCase() === 'json'
    const bodyStart = afterTicks + (isJson ? 4 : 0)
    const close = text.indexOf('```', bodyStart)
    if (close === -1) return isJson ? text.slice(bodyStart) : null
    from = close + 3
  }
}

/** 批次呈交形态探测（issue #341）：模型呈交批次的词法形态，与
 * extractBatchJson 的提取视野互补——可解析的批次由其判为校验对象，
 * 解析不到但呈交信封可辨的（围栏内含 commands 字段、未闭合围栏、
 * 裸 JSON 开头）仍是交付尝试，按既有配额纠正。无围栏的行内字段解释、
 * 引用与代码示例（散文开头的行内片段）不构成呈交——纯讨论不得据此
 * 锁存交付期待并烧纠正预算。 */
export function looksLikeBatchAttempt(text: string): boolean {
  const last = lastFenceBody(text)
  if (last !== null && /"commands"\s*:/.test(last)) return true
  const pending = pendingFenceBody(text)
  if (pending !== null && /"commands"\s*:/.test(pending)) return true
  const trimmed = text.trim()
  return trimmed.startsWith('{') && /"commands"\s*:/.test(trimmed)
}
