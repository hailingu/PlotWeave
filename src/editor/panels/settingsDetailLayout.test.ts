import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 详情表单盒模型契约（PR #97 评审：全宽字段不越出详情卡片）。
 * happy-dom 无布局引擎，盒模型溢出经 postcss 以声明契约校验：
 * `.pw-settings-detail-body` 全宽（width: 100%）且带水平内边距与边框，
 * 必须声明 border-box——content-box 下按 (100% + 内边距 + 边框) 计算，
 * 会越过详情卡片右缘并在 .pw-panel-scroll 产生横向溢出。
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const css = readFileSync(join(repoRoot, 'src/editor/panels/settings-detail.css'), 'utf8')

/** 目标选择器的声明表（postcss 解析生产样式表，非文本断言）。 */
function declarationsOf(selector: string): Map<string, string> {
  const map = new Map<string, string>()
  postcss.parse(css).walkRules(selector, (rule) => {
    for (const node of rule.nodes ?? []) {
      if (node.type === 'decl') map.set(node.prop, node.value)
    }
  })
  return map
}

describe('详情表单盒模型契约（PR #97 评审）', () => {
  it('全宽多行正文字段声明 border-box，内边距计入宽度', () => {
    const decls = declarationsOf('.pw-settings-detail-body')
    expect(decls.get('width')).toBe('100%')
    expect(decls.get('box-sizing')).toBe('border-box')
  })
})
