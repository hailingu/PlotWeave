/**
 * #75 的保守交付提示策略：只识别显式修改表达来触发有界纠正，
 * 不解析目标、不产生命令、不授予执行权限。批次仍由模型生成并经确认。
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
const CHANGE: IntentVocabulary = {
  fragments: ['增加', '新增', '添加', '创建', '新建', '删除', '移除', '修改', '更新', '改为', '改成', '替换', '补充', '丰富', '续写', '连接', '连到', '断开', '重排'],
  words: /\b(?:add|create|delete|remove|update|change|connect|disconnect)\b/i,
}

/** 片段和单词两种匹配方式共用一份词表，不构造动态正则。 */
function matches(vocabulary: IntentVocabulary, text: string): boolean {
  return vocabulary.fragments.some((fragment) => text.includes(fragment)) || vocabulary.words.test(text)
}

/** 仅针对本轮用户输入决定是否期待预览；省略或歧义表达留给正常对话。 */
export function expectsActionPreview(text: string): boolean {
  return !matches(DISCUSSION, text) && matches(TARGET, text) && matches(CHANGE, text)
}

/** 模型主动声称提供预览时也应核对交付，不依赖用户是否用了操作关键词。 */
export function claimsActionPreview(text: string): boolean {
  return /(?:见|查看|点击|下方|下面).{0,8}(?:预览卡|执行改动)/.test(text)
}
