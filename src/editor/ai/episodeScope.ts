/** #929：分集必须属于当前用户请求，历史方案、节点文案和模型理由不能扩大范围。 */
import type { ThreadEntry } from '../../ai/session'
import type { BatchValidation } from './commands'

/** 明确的分集词或目标集号；不把普通「集」「集合」当作分集请求。 */
function mentionsEpisode(text: string): boolean {
  const assigned = text.replace(/未分集/g, '')
  return (
    ['分集', '归集', '集归属', '集号'].some((term) =>
      assigned.includes(term),
    ) ||
    /第\s*[\d一二三四五六七八九十百零〇两]+\s*集/.test(assigned) ||
    /\bepisode(?:s|No)?\b/i.test(assigned)
  )
}

/** 否定直接作用于同一分句的分集动作时保留归属，不否决「不要解释，安排分集」。 */
function keepsEpisodes(request: string): boolean {
  return request.split(/[，。；\n,;.!]/).some((clause) => {
    const negation =
      /不要|不用|无需|不必|别|勿|保持|不(?=分集|归集)|\bdo not\b|\bdon't\b|\bwithout\b|\bno\b/i.exec(
        clause,
      )
    return (
      negation !== null &&
      (mentionsEpisode(clause.slice(negation.index + negation[0].length)) ||
        clause.includes('未分集'))
    )
  })
}
/** 询问分集知识不授权模型改分集；不确定的表达由模型澄清具体请求。 */
const DISCUSS_EPISODES =
  /^(?:请)?(?:如何|怎么|为什么|是否|解释|讨论)|^\s*(?:how|why|what)\b/i

/** 将合法形状批次按本轮分集范围再校验；整批拒绝而非静默剥离字段。 */
export function validateEpisodeScope(
  validation: BatchValidation | null,
  request: string,
): BatchValidation | null {
  if (!validation?.ok) return validation
  if (
    mentionsEpisode(request) &&
    !keepsEpisodes(request) &&
    !DISCUSS_EPISODES.test(request)
  )
    return validation
  const issues = validation.commands.flatMap((command, index) => {
    let fields: Record<string, unknown> | undefined
    if (command.op === 'create_node') fields = command.data
    else if (command.op === 'update_node') fields = command.patch.patch
    return fields && Object.prototype.hasOwnProperty.call(fields, 'episodeNo')
      ? [
          {
            index,
            message:
              '本轮未明确要求分集，不能写入 episodeNo。请保持现有归属，新建内容省略集号；需要分集时请先向用户确认具体分集要求。',
          },
        ]
      : []
  })
  return issues.length === 0
    ? validation
    : {
        ...validation,
        ok: false,
        commands: [],
        issues,
      }
}

/** 旧卡恢复/执行仍绑定它之前最近的用户消息，后续分集请求不授权历史卡。 */
export function requestForEntry(thread: ThreadEntry[], index: number): string {
  for (let i = index - 1; i >= 0; i--) {
    const entry = thread[i]
    if (entry?.kind === 'msg' && entry.role === 'user') return entry.text
  }
  return ''
}
