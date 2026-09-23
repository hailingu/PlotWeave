/**
 * CSS 变量引用的词法边界与消费回归（reviews 5280334884、5287535185）。
 * 状态矩阵见 docs/css-token-contract.md F5；通过真实 PostCSS
 * 声明与共享引擎验证依赖、接线、替换及恢复，不读取源文件文本断言布局。
 */
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import {
  allVarRefs,
  danglingRefs,
  displayTypeErrors,
  displayValueIn,
  LIGHT_ENV,
  localDefinitions,
  resolveChain,
  sheetDecls,
  tokenValuesOf,
  unresolvedRefsIn,
} from './sheetTokensEngine'

/** 给定声明列表的实际消费值，覆盖声明扫描、局部定义与根令牌两条入口。 */
function consume(
  css: string,
  tokens = new Map<string, string>(),
): string | null {
  const root = postcss.parse(css)
  const declaration = [...sheetDecls(root)].find(
    (decl) => !decl.prop.startsWith('--'),
  )
  if (!declaration) throw new Error('夹具缺少消费声明')
  const context = { env: LIGHT_ENV, tokens, locals: localDefinitions(root) }
  expect(unresolvedRefsIn(declaration, context)).toEqual([])
  return displayValueIn(declaration, context)
}

describe('字面内容不构成变量依赖（review 5280334884）', () => {
  it.each([
    '"var(--label)"',
    "'var(--label)'",
    '"var(--missing"',
    '"), var(--label) ("',
    String.raw`"escaped\" var(--label)"`,
    'url("/assets/var(--label).svg")',
    'URL("data:image/svg+xml,<svg id=\'var(--label)\'/>")',
    String.raw`url(/assets/var\(--label\).svg)`,
    'url("/assets/var(--missing.svg")',
  ])('局部值保持原样且不形成自环：%s', (literal) => {
    const css = `.a { --label: ${literal}; content: var(--label) }`
    expect(allVarRefs(literal)).toEqual([])
    expect(danglingRefs(postcss.parse(css), LIGHT_ENV)).toEqual([])
    expect(consume(css)).toBe(literal)
  })

  it.each(['"var(--label)"', 'url("/var(--label).svg")'])(
    '根变量与局部变量共享字面边界：%s',
    (literal) => {
      const tokens = tokenValuesOf(
        postcss.parse(`:root { --label: ${literal}; }`),
        LIGHT_ENV,
      )
      expect(consume('.a { content: var(--label) }', tokens)).toBe(literal)
    },
  )
})

describe('混合值仅解析真实引用（review 5280334884）', () => {
  it.each([
    ['"var(--missing)" var(--label)', '"var(--missing)" "ok"'],
    ['var(--label) "var(--missing)"', '"ok" "var(--missing)"'],
    [
      'url("/var(--missing).svg") var(--label)',
      'url("/var(--missing).svg") "ok"',
    ],
    [
      '"var(--missing)" var(--label) var(--label)',
      '"var(--missing)" "ok" "ok"',
    ],
  ])('保留字面内容并替换引用：%s', (value, expected) => {
    expect(allVarRefs(value)).toEqual(
      value.endsWith('var(--label) var(--label)')
        ? ['--label', '--label']
        : ['--label'],
    )
    expect(consume(`.a { --label: "ok"; content: ${value} }`)).toBe(expected)
    expect(resolveChain(value, new Map([['--label', '"ok"']]))).toBe(expected)
  })

  it.each([
    '"var(--fake)" var(--missing)',
    'url("/var(--fake).svg") var(--missing)',
  ])('字面之后的真实悬空名仍报告：%s', (value) => {
    expect(
      danglingRefs(postcss.parse(`.a { content: ${value} }`), LIGHT_ENV),
    ).toEqual([{ selector: '.a', ref: '--missing' }])
    expect(() => resolveChain(value, new Map())).toThrow(/var\(\) 链过深或悬空/)
  })

  it('简易链入口保留被替换结果中的字面 var 文本', () => {
    const tokens = new Map([
      ['--label', 'var(--text)'],
      ['--text', '"var(--text)"'],
    ])
    expect(resolveChain('var(--label)', tokens)).toBe('"var(--text)"')
  })

  it('保留引号不意味着字符串可以作为颜色', () => {
    const root = postcss.parse(
      '.a { --label: "var(--label)"; color: var(--label) }',
    )
    expect(danglingRefs(root, LIGHT_ENV)).toEqual([])
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
      '.a color: "var(--label)"',
    ])
  })
})

describe('字面与真实 fallback 依赖（review 5280334884）', () => {
  it.each([
    ['var(--missing, "var(--missing)")', '"var(--missing)"'],
    ['var(--missing, "), var(--missing) (")', '"), var(--missing) ("'],
    [
      'var(--missing, url("/var(--missing).svg"))',
      'url("/var(--missing).svg")',
    ],
    ['var(--missing, url("/asset).svg"))', 'url("/asset).svg")'],
    ['var(--missing, "literal") "var(--unused)"', '"literal" "var(--unused)"'],
  ])('缺失主值选择字面回退且保留函数边界：%s', (value, expected) => {
    expect(allVarRefs(value)).toEqual(['--missing'])
    expect(consume(`.a { content: ${value} }`)).toBe(expected)
  })

  it('未选择的真实 fallback 仍参与环检测，字符串不参与', () => {
    const cyclic =
      '.a { --label: var(--valid, var(--label)); --valid: "ok"; content: var(--label, "recovered") }'
    expect(consume(cyclic)).toBe('"recovered"')
    const literal =
      '.a { --label: var(--valid, "var(--label)"); --valid: "ok"; content: var(--label) }'
    expect(consume(literal)).toBe('"ok"')
  })

  it('真实间接循环不会被相邻字符串掩盖', () => {
    const cyclic =
      '.a { --label: "var(--fake)" var(--other); --other: var(--label); content: var(--label, "recovered") }'
    expect(consume(cyclic)).toBe('"recovered"')
    expect(allVarRefs('var(--valid, "var(--fake)" var(--label))')).toEqual([
      '--valid',
      '--label',
    ])
  })
})

describe('F5-b：var 函数名大小写与自定义属性原样匹配', () => {
  it.each(['VAR', 'VaR', 'vAr'])(
    '函数名 %s 的缺失引用会进入真实声明接线检查',
    (fn) => {
      const value = `${fn}(--missing)`
      expect(allVarRefs(value)).toEqual(['--missing'])
      expect(
        danglingRefs(postcss.parse(`.a { width: ${value} }`), LIGHT_ENV),
      ).toEqual([{ selector: '.a', ref: '--missing' }])
      expect(() => resolveChain(value, new Map())).toThrow()
    },
  )

  it('合法混合大小写函数经局部定义求值并进入展示色类型检查', () => {
    const css = '.a { --Color: #fff; color: VaR(--Color) }'
    const root = postcss.parse(css)
    expect(danglingRefs(root, LIGHT_ENV)).toEqual([])
    expect(consume(css)).toBe('#fff')
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([])
    expect(resolveChain('VaR(--Color)', new Map([['--Color', '#fff']]))).toBe(
      '#fff',
    )
  })

  it('函数名可变大小写，自定义属性名仍严格区分大小写', () => {
    const css = '.a { --Color: #fff; color: VAR(--color) }'
    expect(danglingRefs(postcss.parse(css), LIGHT_ENV)).toEqual([
      { selector: '.a', ref: '--color' },
    ])
    expect(resolveChain('VAR(--Color)', new Map([['--Color', '#fff']]))).toBe(
      '#fff',
    )
  })

  it.each([
    ['VAR(--missing, vAr(--Color))', ['--missing', '--Color']],
    ['VAR(--Color, vAr(--missing))', ['--Color', '--missing']],
  ])('主值与备用路径按是否选中求值：%s', (value, expectedRefs) => {
    const css = `.a { --Color: #fff; color: ${value} }`
    expect(allVarRefs(value)).toEqual(expectedRefs)
    expect(danglingRefs(postcss.parse(css), LIGHT_ENV)).toEqual([])
    expect(consume(css)).toBe('#fff')
  })

  it('大写函数名在字符串、URL 与其他函数名内仍不是变量引用', () => {
    const value =
      '"VAR(--missing)" URL("/VAR(--missing).svg") notVAR(--missing)'
    expect(allVarRefs(value)).toEqual([])
    expect(
      danglingRefs(postcss.parse(`.a { content: ${value} }`), LIGHT_ENV),
    ).toEqual([])
    expect(resolveChain(value, new Map())).toBe(value)
  })

  it('大小写混用的备用依赖仍可形成变量环并选回退值', () => {
    const css =
      '.a { --left: VAR(--right); --right: vAr(--left); color: VAR(--left, #fff) }'
    expect(allVarRefs('vAr(--left)')).toEqual(['--left'])
    expect(consume(css)).toBe('#fff')
  })
})
