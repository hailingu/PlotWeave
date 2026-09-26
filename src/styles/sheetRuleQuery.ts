//! 样式表规则查询内核（自 sheetTokensEngine 拆分的独立职责，issue
//! #290 评审）：按完整选择器定位唯一无条件规则、属性生效值与简写/长形
//! 胜出声明——取胜规则（!important 优先、同重要性取源序最后）单源维护。

import postcss from 'postcss'

/** 标准属性名 ASCII 大小写不敏感，归一为小写；自定义属性名保持大小写敏感。 */
export function normalizeProp(prop: string): string {
  return prop.startsWith('--') ? prop : prop.toLowerCase()
}

/**
 * 在给定根节点内按完整选择器找规则：须**唯一且无条件**（不处于任何
 * at-rule 内）——媒体块内同名规则会使生效值随环境分叉，违背黄金接线
 * 「恒值」前提；同名重复规则使文本序后位遮蔽先位，定位失真。选择器
 * 列表逐分支匹配：后续规则若在逗号分支中含目标选择器（如
 * `.other, .pw-dialog-danger { ... }`）仍能以同等特异性覆盖目标规则，
 * 也计入命中——不按整选择器字符串相等。sheet 仅用于错误信息；缺失/
 * 重复/条件化均抛错防测试静默空过。
 */
export function ruleIn(
  root: postcss.Root,
  sheet: string,
  selector: string,
): postcss.Rule {
  const matches: postcss.Rule[] = []
  root.walkRules((rule) => {
    const branches = rule.selector.split(',').map((branch) => branch.trim())
    if (branches.includes(selector)) matches.push(rule)
  })
  if (matches.length === 0) throw new Error(`未找到规则 ${sheet} ${selector}`)
  if (matches.length > 1) {
    throw new Error(
      `${sheet} ${selector} 有 ${matches.length} 条包含该分支的规则，须唯一`,
    )
  }
  const rule = matches[0]!
  if (rule.parent?.type !== 'root') {
    throw new Error(`${sheet} ${selector} 处于 at-rule 内，须无条件规则`)
  }
  return rule
}

/** 规则内该属性的生效值：属性名先按标准大小写归一，!important 声明优先于普通声明，同重要性取源序最后一条。 */
export function declOf(rule: postcss.Rule, prop: string): string {
  return winningDecl(rule, [prop]).value
}

/** 一组互相覆盖的属性（如简写与长形）在规则内的胜出声明，取胜规则同 declOf。 */
export function winningDecl(
  rule: postcss.Rule,
  props: readonly string[],
): postcss.Declaration {
  const targets = new Set(props.map(normalizeProp))
  const decls = rule.nodes.filter(
    (node): node is postcss.Declaration =>
      node.type === 'decl' && targets.has(normalizeProp(node.prop)),
  )
  if (decls.length === 0) {
    throw new Error(`${rule.selector} 缺少 ${props.join('/')} 声明`)
  }
  const important = decls.filter((decl) => decl.important)
  const winners = important.length > 0 ? important : decls
  return winners[winners.length - 1]!
}
