/** 前端沿用宿主的 level/target/message 字段，追加机器码并原样交付原诊断上下文。 */

/** 使用 Rust log 的大写级别值，调用方显式声明事件严重度。 */
export type DiagnosticLevel = 'WARN' | 'ERROR'

/** 机器可读的共同记录；message 保留原 console 前缀，不覆盖既有负载的 message。 */
export interface DiagnosticRecord {
  readonly level: DiagnosticLevel
  readonly target: string
  readonly message: string
  readonly code: string
}

/** 原前缀与全部原参数保持原位置；末项为共同记录，不检查、复制或序列化上下文。 */
export function reportDiagnostic(
  record: DiagnosticRecord,
  ...context: unknown[]
): void {
  if (record.level === 'ERROR')
    console.error(record.message, ...context, record)
  else console.warn(record.message, ...context, record)
}

/** 在模块边界绑定显式事件信息；创建时静默，输出时才读取最新 console sink。 */
export function createDiagnostic(
  level: DiagnosticLevel,
  target: string,
  code: string,
): (message: string, ...context: unknown[]) => void {
  return (message, ...context) =>
    reportDiagnostic({ level, target, message, code }, ...context)
}
