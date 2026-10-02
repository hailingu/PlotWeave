/** IPC 错误机器码（issue #229）：后端在需要程序判定的错误文案前加
 * `[code] ` 前缀（与 issue #144 保留的 Result<_, String> 出口契约兼容）。
 * 码只服务前端分支判定（当前登记：`project_not_found`——空库播种的存在性
 * 探测），不上屏；无码/非法形态回退 null，消费者按未知类别保守处理
 * （如播种只认 project_not_found，其余一律视为「存在但不可读」不覆盖）。 */

/** 码词法：小写蛇形 + 数字；后随一个空格与文案分隔。 */
const CODE_PREFIX = /^\[([a-z0-9_]+)\] /

/** 提取 IPC 错误的机器码；无码或非文本形态回退 null。 */
export function ipcErrorCode(err: unknown): string | null {
  if (err instanceof Error) return codeOf(err.message)
  if (typeof err === 'string') return codeOf(err)
  return null
}

function codeOf(text: string): string | null {
  return CODE_PREFIX.exec(text)?.[1] ?? null
}

/** 展示文本：剥离码前缀（Error 取 message，不带 `Error: ` 前缀），无码原样。 */
export function displayIpcError(err: unknown): string {
  if (err instanceof Error) return err.message.replace(CODE_PREFIX, '')
  if (typeof err === 'string') return err.replace(CODE_PREFIX, '')
  return String(err)
}
