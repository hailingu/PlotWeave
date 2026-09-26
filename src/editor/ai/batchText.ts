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

/** 批次呈交形态探测（issue #341）：模型呈交批次的词法形态——```json 围栏
 * 内含 commands 字段，或以裸 {"commands" 前缀开头，与 extractBatchJson 的
 * 提取视野一致。命中表示本轮呈交了批次形态的内容，可解析性另由
 * extractBatchJson 判定；无围栏的行内字段解释、引用与代码示例不构成呈交
 * ——纯讨论不得据此锁存交付期待并烧纠正预算。 */
export function looksLikeBatchAttempt(text: string): boolean {
  const last = lastFenceBody(text)
  if (last !== null && /"commands"\s*:/.test(last)) return true
  return text.trim().startsWith('{"commands"')
}
