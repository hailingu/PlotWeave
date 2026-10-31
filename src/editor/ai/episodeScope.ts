/** #929：分集必须属于当前用户请求，历史方案、节点文案和模型理由不能扩大范围。 */
import type { AiEpisodeScope, ThreadEntry } from '../../ai/session'
import type { BatchIssue, BatchValidation, ValidatedCommand } from './commands'

const EPISODE_WORDS = ['分集', '归集', '集归属', '集号']
/** 数字片段有界扫描（安全整数最多 16 位十进制），中文表达预留空间；「第」可省略。 */
const NUMBERED_EPISODE = /(?:第\s*)?[\d一二三四五六七八九十百零〇两]{1,32}\s*集/
const ENGLISH_EPISODE = /\bepisode(?:s|No)?\b/i
const EPISODE_ADDITIONS = ['新增', '增加', '添加']
/** 明确创建或在指定集创建内容，沿用既有的集归属范围。 */
const EPISODE_CREATIONS = ['创建', '新建', '建立']
/** 这些动词也可改写集内内容，仅凭集号前出现动词不足以授予分集范围。 */
const EPISODE_CONTENT_EDITS = ['设置', '设定', '修改', '更改', '调整']
/** 直接给集字段赋值时，字段与动词必须紧邻目标，不依赖目标后的整理说明。 */
const EPISODE_FIELD_ASSIGNMENT = new RegExp(
  String.raw`(?:${EPISODE_WORDS.join('|')})\s*(?:${EPISODE_CONTENT_EDITS.join('|')})(?:为|成|至|到)?\s*$`,
)
/** 明确创建/归入动作独立授予范围，不被同窗中的内容改写词否决。 */
const EPISODE_EXPLICIT_ASSIGNMENTS = [
  '安排',
  ...EPISODE_CREATIONS,
  '分配',
  '划分',
  '归入',
  '归到',
  '归属',
  '划入',
  '设为',
  '改为',
  '改成',
  '放入',
  '放到',
  '移到',
  '移入',
  '重分',
]
/** 否定仍覆盖所有分集动作，包括可指向内容的改写动词。 */
const EPISODE_ASSIGNMENTS = [
  ...EPISODE_EXPLICIT_ASSIGNMENTS,
  ...EPISODE_CONTENT_EDITS,
]

/** 明确的分集词或目标集号；不把普通「集」「集合」当作分集请求。 */
function mentionsEpisode(text: string): boolean {
  const assigned = text.replace(/未分集/g, '')
  return (
    EPISODE_WORDS.some((term) => assigned.includes(term)) ||
    NUMBERED_EPISODE.test(assigned) ||
    ENGLISH_EPISODE.test(assigned)
  )
}

/** 否定直接作用于同一分句的分集动作时保留归属，不否决「不要解释，安排分集」。 */
function keepsEpisodes(request: string): boolean {
  return request.split(/[，。；\n,;.!]/).some((clause) => {
    if (!mentionsEpisode(clause) && !clause.includes('未分集')) return false
    if (
      /保持|保留|维持|沿用|照旧|不变|不动|原样|\b(?:keep|preserve|retain|unchanged)\b/i.test(
        clause,
      )
    )
      return true
    if (
      /不要|不用|无需|无须|不必|不需要|不再|别|勿|禁止|\b(?:do not|don't|without|no|never)\b/i.test(
        clause,
      )
    )
      return true
    const negative = clause.indexOf('不')
    if (negative < 0) return false
    const action = clause.slice(negative + 1).trimStart()
    return [
      ...EPISODE_ASSIGNMENTS,
      ...EPISODE_ADDITIONS,
      '分集',
      '归集',
      '恢复',
      '改变',
      '变动',
      '动',
      '改',
      '重新',
      '随意',
      '擅自',
      '自行',
      '自动',
    ].some((term) => action.startsWith(term))
  })
}

/** 「为/给…分集」是直接操作；讲解、讨论或建议中的分集词不授予写入范围。 */
function isDirectEpisodeArrangement(text: string): boolean {
  return (
    /^请?[为给]/.test(text) &&
    /(?:分集|归集)$/.test(text) &&
    !/解释|讨论|描述|介绍|讲解|建议/.test(text)
  )
}

/** 新增须紧接集目标；「增加节拍参考第一集」不属于目标新增。 */
function isDirectEpisodeAddition(before: string): boolean {
  return (
    EPISODE_ADDITIONS.some((term) => before.trimEnd().endsWith(term)) ||
    /\badd\s*$/i.test(before)
  )
}

/** 明确动作先独立判定，只有单独的模糊内容改写需要集目标后缀限定。 */
function assignsEpisodeTarget(before: string, after: string): boolean {
  if (
    isDirectEpisodeAddition(before) ||
    EPISODE_FIELD_ASSIGNMENT.test(before) ||
    EPISODE_EXPLICIT_ASSIGNMENTS.some((term) => before.includes(term)) ||
    /\b(?:create|assign|move|set|split|group|organize)\b/i.test(before)
  )
    return true
  return (
    EPISODE_CONTENT_EDITS.some((term) => before.includes(term)) &&
    /^(?:$|并|再|然后|且|同时)/.test(after)
  )
}

/** 「在第 N 集新增内容」明确指定新内容归属，保留既有创建路径。 */
function createsInEpisode(
  text: string,
  index: number,
  numbered: RegExpExecArray | null,
): boolean {
  return (
    numbered?.index === index &&
    /^请?[在为给向往]\s*$/.test(text.slice(0, index)) &&
    /新增|增加|创建|添加/.test(text.slice(index + numbered[0].length))
  )
}

/** 一个集提及只有与分集动作直接结合，或明确承载新增内容时才是写入目标。 */
function targetsEpisode(
  text: string,
  index: number,
  numbered: RegExpExecArray | null,
): boolean {
  if (index < 0) return false
  const before = text.slice(Math.max(0, index - 16), index)
  const after =
    numbered?.index === index
      ? text.slice(index + numbered[0].length).trimStart()
      : ''
  return (
    assignsEpisodeTarget(before, after) ||
    createsInEpisode(text, index, numbered)
  )
}

/** 分句内区分直接分集、显式集字段与数字集目标，动作窗口保持原有边界。 */
function clauseChangesEpisodes(clause: string): boolean {
  const text = clause.replace(/未分集/g, '').trim()
  if (text === '分集' || text === '归集' || isDirectEpisodeArrangement(text))
    return true
  const numbered = NUMBERED_EPISODE.exec(text)
  const english = ENGLISH_EPISODE.exec(text)
  return [
    ...EPISODE_WORDS.map((term) => text.indexOf(term)),
    numbered?.index ?? -1,
    english?.index ?? -1,
  ].some((index) => targetsEpisode(text, index, numbered))
}

/** 提及旧集号不等于分集：只认分配动作与目标集的组合，含糊表达保留归属。 */
function requestsEpisodeChange(request: string): boolean {
  return request.split(/[，。；\n,;.!]/).some(clauseChangesEpisodes)
}
/** 询问分集知识不授权模型改分集；不确定的表达由模型澄清具体请求。 */
const DISCUSS_EPISODES =
  /^(?:请)?(?:如何|怎么|为什么|是否|解释|讨论)|^\s*(?:how|why|what)\b/i

/** 只从本轮原始请求提取固定大小的分集范围，供卡片跨裁剪保留。 */
export function episodeScopeForRequest(request: string): AiEpisodeScope {
  if (
    requestsEpisodeChange(request) &&
    !keepsEpisodes(request) &&
    !DISCUSS_EPISODES.test(request)
  )
    return 'allow'
  return 'preserve'
}

/** 范围拒绝只识别实际写入字段，标题文案及其他命令不能被误作分集写入。 */
function outOfScopeEpisodeIssue(
  command: ValidatedCommand,
  index: number,
): BatchIssue[] {
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
}

/** 将合法形状批次按本轮分集范围再校验；整批拒绝而非静默剥离字段。 */
export function validateEpisodeScope(
  validation: BatchValidation | null,
  request: string,
  recordedScope?: AiEpisodeScope,
): BatchValidation | null {
  if (!validation?.ok) return validation
  if (
    (recordedScope ?? episodeScopeForRequest(request)) === 'allow' &&
    (request === '' || episodeScopeForRequest(request) === 'allow')
  )
    return validation
  const issues = validation.commands.flatMap((command, index) =>
    outOfScopeEpisodeIssue(command, index),
  )
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
