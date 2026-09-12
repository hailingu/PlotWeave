/**
 * #75 的保守交付提示策略 + #91 的 query 改写通道：本地词表只承担
 * 快速路径判定与改写结果的动词门，开放动词（扩写、润色等口语表达）
 * 由改写调用归一化（queryRewrite.ts）。词表不解析目标、不产生命令、
 * 不授予执行权限，批次仍由模型生成并经确认。
 */

/** 中文按片段匹配，英文保留单词边界；词表只影响纠正提示，不解析命令。 */
interface IntentVocabulary {
  fragments: readonly string[]
  words: RegExp
}

/** 用法提问、讨论与明确禁止操作优先作为文本回合，避免强求写方案。 */
const DISCUSSION: IntentVocabulary = {
  fragments: ['如何', '怎么', '怎样', '为什么', '是否', '讨论', '解释', '建议', '不要', '不用', '别', '暂不', '先不', '只聊', '只说', '只需说明'],
  words: /\b(?:how|why|discuss|explain|do not|don't)\b/i,
}
/** 首期已支持的画布／设定实体对象；不扩展道具或设定文档写能力。 */
const TARGET: IntentVocabulary = {
  fragments: ['画布', '节点', '场景', '节奏卡', '节拍', '分镜', '对白', '台词', '旁白', '分支', '连线', '角色', '地点'],
  words: /\b(?:canvas|node|scene|shot|beat|dialogue|character|location)\b/i,
}
/** 规范动作动词：既是快速路径的命中词表，也是改写输出的动词门
 * （queryRewrite 提示词与本表同源，改写结果必须落在清单内才采信）。 */
const CHANGE: IntentVocabulary = {
  fragments: ['增加', '新增', '添加', '创建', '新建', '删除', '移除', '修改', '更新', '改为', '改成', '替换', '补充', '丰富', '续写', '连接', '连到', '断开', '重排'],
  words: /\b(?:add|create|delete|remove|update|change|connect|disconnect)\b/i,
}

/** 片段和单词两种匹配方式共用一份词表，不构造动态正则。 */
function matches(vocabulary: IntentVocabulary, text: string): boolean {
  return vocabulary.fragments.some((fragment) => text.includes(fragment)) || vocabulary.words.test(text)
}

/** 改写提示词引用的规范动词清单，与 CHANGE 词表保持同源。 */
export const ACTION_VERBS: readonly string[] = CHANGE.fragments

/** 仅针对本轮用户输入决定是否期待预览；省略或歧义表达留给正常对话。 */
export function expectsActionPreview(text: string): boolean {
  return !matches(DISCUSSION, text) && matches(TARGET, text) && matches(CHANGE, text)
}

/** 输入已含动作动词时无需改写判定：目标含糊仍属修改意图（如「再丰富点」）。 */
export function hasActionVerb(text: string): boolean {
  return matches(CHANGE, text)
}

/** 无动作动词的含糊输入才需要改写调用判定（每轮至多一次）。讨论/否定
 * 片段不否决改写（PR #92 评审）：否定辖域（「不要解释」vs「不要修改」）
 * 与「特别」这类偶发子串，片段匹配无法判别而改写调用可以；明确暂不操
 * 作的保护由动词快速路径加 expectsActionPreview 否决、以及改写提示词
 * 的 NONE 分类（无动词输入）共同承担。 */
export function needsActionRewrite(text: string): boolean {
  const trimmed = text.trim()
  return trimmed !== '' && !matches(CHANGE, trimmed)
}

/** 引导查看预览卡的表达。 */
const PREVIEW_REFERENCE = /(?:见|查看|点击|下方|下面).{0,8}(?:预览卡|执行改动)/

/** 「确认后预览会展示……」式交付承诺（issue 91 截图措辞）：确认门控、
 * 预览与展示动词同句共现才识别，预览与展示的先后两种语序各一条正则
 * （S5843 复杂度上限内）；跨句、疑问与元描述为已知边界。 */
const PREVIEW_PROMISE_AFTER =
  /确认(?:后|之后|以后)[^。；\n]{0,16}预览[^。；\n]{0,10}(?:展示|显示|呈现|列出|给出)/
const PREVIEW_PROMISE_BEFORE =
  /确认(?:后|之后|以后)[^。；\n]{0,16}(?:展示|显示|呈现|列出|给出)[^。；\n]{0,10}预览/

/** 否定标记（PR #92 评审）：出现在匹配片段内即不构成交付承诺，如
 * 「确认后预览不会显示任何改动」「确认后无法展示预览」；「不」紧邻
 * 展示动词的形态（「预览不展示」）单独覆盖，避免「不同」误伤。 */
const NEGATION = /(?:不会|不能|无法|没有|无从|并不|并非|不(?=[展显呈列给]))/

/** 匹配成功且片段内无否定标记才构成承诺；否定辖域不跨出片段——
 * 「确认后预览会展示改动，不会丢失」中承诺仍然成立。 */
function claimsMatch(text: string, pattern: RegExp): boolean {
  const span = pattern.exec(text)?.[0]
  return span !== undefined && !NEGATION.test(span)
}

/** 模型主动声称提供预览时也应核对交付，不依赖用户是否用了操作关键词。 */
export function claimsActionPreview(text: string): boolean {
  return claimsMatch(text, PREVIEW_REFERENCE) || claimsMatch(text, PREVIEW_PROMISE_AFTER)
    || claimsMatch(text, PREVIEW_PROMISE_BEFORE)
}
