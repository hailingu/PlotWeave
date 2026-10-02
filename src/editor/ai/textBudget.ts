/**
 * AI 自由文本字段的写入体积预算（issue #170）：patchShape（节点字段）、
 * entityFold（实体/文档字段）的入站校验与 nodeFields/entityFields 的
 * 工具 schema 广告共用同一组常量，执行边界与模型可见协议不再漂移。
 * 政策：超限整批拒绝并回喂诊断，绝不自行截断用户内容；单批总体积由
 * 对话响应体 16 MiB 上限（prefs.rs CHAT_RESPONSE_BODY_MAX_BYTES）兜底，
 * 本预算管的是单字段/单成员的病态极值（审计探针：2 MiB synopsis 曾被
 * 原样接受）。
 */

/** 普通自由文本字段的字符数上限（65,536）：梗概/台词/画面描述/Prompt/
 * 小传/备注/选项与引用位文案同域——远超短剧单场用量（一场全文通常
 * 数千字），与同族现有预算（会话历史 48,000 字符截断）同量级。 */
export const FREE_TEXT_MAX_CHARS = 64 * 1024

/** 设定文档正文的字符数上限（1,048,576）：body 定位「长篇正文，整体
 * 替换」，对齐项目文件级上限先例的 1 MiB 量级（PREFS_MAX_BYTES /
 * INDEX_MAX_BYTES），容纳长篇设定仍拦截多 MiB 病态输入。 */
export const DOCUMENT_BODY_MAX_CHARS = 1024 * 1024

/** 单字段长度预算诊断：值在场为字符串且超过 max 时返回点名字段与
 * 实际上限的错误文案；非字符串/缺省/上限内返回 null（类型形状由
 * 调用方各自的形状校验先行判定）。字符数按 Unicode 码点计（for..of
 * 迭代语义），与工具 schema 广告的 JSON Schema maxLength 同口径——按
 * UTF-16 码元（String.length）会让星号平面字符（emoji 等）双计，
 * 模型可见契约与校验边界漂移（PR #204 评审）。计数不物化码点数组
 * （病态 16 MiB 输入下数组展开自身即成内存放大点，同评审）：码元数
 * 不超限时码点数必然不超限，短文本 O(1) 直通；仅可疑输入逐码点迭代。 */
export function textBudgetIssue(
  field: string,
  value: unknown,
  max: number = FREE_TEXT_MAX_CHARS,
): string | null {
  if (typeof value !== 'string' || value.length <= max) return null
  const codePoints = value[Symbol.iterator]()
  let chars = 0
  while (!codePoints.next().done) chars += 1
  if (chars <= max) return null
  return `${field} 长度超过上限（最多 ${max} 字符，实际 ${chars} 字符）`
}
