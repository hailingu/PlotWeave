/**
 * 画布缩放控件（React Flow Controls）主题接线契约（issue #93）。
 *
 * 依据的机器契约：
 * - @xyflow/react v12 官方主题变量：dist/style.css 中 .react-flow__controls-button
 *   经 var(--xy-controls-button-background-color, …-default) 等变量链取色，
 *   这些自定义属性名是 React Flow 公开主题 API；
 * - 应用设计令牌（docs/ui-design.md §2、src/styles/tokens.css）：
 *   组件层只引用语义令牌，不硬编码颜色。
 *
 * 不变量：控件配色只能经 RF 主题变量注入——自定义属性随继承生效，与样式表
 * 注入顺序无关。回归背景：编辑器是懒加载 chunk，@xyflow/react/dist/style.css
 * 必然晚于应用样式注入，同特异性对按钮直接声明 background/color 会整体落败，
 * 暗色下回落 RF 浅色默认 #fefefe 底 + inherit 继承的浅色图标，图标不可辨。
 */
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const stylesheet = postcss.parse(readFileSync(new URL('./nodes.css', import.meta.url), 'utf8'))

/** 按精确选择器取规则；同选择器多条时返回首条。 */
function rule(selector: string): postcss.Rule | undefined {
  return stylesheet.nodes.find(
    (node): node is postcss.Rule => node.type === 'rule' && node.selector === selector,
  )
}

function declarations(rule: postcss.Rule): Map<string, string> {
  return new Map(
    rule.nodes
      .filter((node): node is postcss.Declaration => node.type === 'decl')
      .map((node) => [node.prop, node.value]),
  )
}

describe('画布控件主题接线（issue #93）', () => {
  it('经 React Flow 官方主题变量引用应用语义令牌（顺序无关生效）', () => {
    const controls = rule('.react-flow__controls')
    expect(controls).toBeDefined()
    const decls = declarations(controls!)
    expect(decls.get('--xy-controls-button-background-color')).toBe('var(--surface-card)')
    expect(decls.get('--xy-controls-button-background-color-hover')).toBe('var(--fill-quaternary)')
    expect(decls.get('--xy-controls-button-color')).toBe('var(--text-primary)')
    expect(decls.get('--xy-controls-button-color-hover')).toBe('var(--text-primary)')
    expect(decls.get('--xy-controls-button-border-color')).toBe('var(--border-hairline)')
  })

  it('不得再对按钮同属性直接声明与 RF 默认样式竞逐（必然因注入顺序落败）', () => {
    const racingProps = ['background', 'color', 'border-bottom']
    const offenders = stylesheet.nodes
      .filter(
        (node): node is postcss.Rule =>
          node.type === 'rule' && node.selector === '.react-flow__controls-button',
      )
      .flatMap((node) => [...declarations(node).keys()])
      .filter((prop) => racingProps.includes(prop))
    expect(offenders).toEqual([])
  })

  it('键盘聚焦态以品牌色描边可辨', () => {
    const focus = rule('.react-flow__controls-button:focus-visible')
    expect(focus).toBeDefined()
    expect(declarations(focus!).get('outline')).toContain('var(--accent)')
  })
})
