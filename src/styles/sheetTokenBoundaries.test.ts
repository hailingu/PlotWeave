/**
 * 全局令牌所有权、@property 注册、颜色属性分类与自定义属性 CSS-wide 取值边界
 * （review 5280542926、5280837519）。错误码契约及状态矩阵见
 * docs/reviews/pr-288-review-5280542926.md 与 pr-288-review-5280837519.md。
 */
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import {
  danglingRefs,
  displayTypeErrors,
  displayValueIn,
  isDisplayColorProp,
  LIGHT_ENV,
  localDefinitions,
  sheetDecls,
  tokenValuesOf,
  TOKEN_SHEET,
} from './sheetTokensEngine'

describe('组件表不得另定义全局令牌', () => {
  it.each([
    ':root',
    'html',
    'body',
    '*',
    '.card, :root',
    ':root.dark',
    'body[data-theme="dark"]',
  ])('无消费者定义表也拒绝全局 %s', (selector) => {
    const root = postcss.parse(`${selector} { --text-primary: 4px; }`, {
      from: 'src/styles/fixture-component.css',
    })
    for (const scan of [
      () => [...sheetDecls(root)],
      () => localDefinitions(root),
      () => danglingRefs(root, LIGHT_ENV),
      () => displayTypeErrors(root, LIGHT_ENV),
    ])
      expect(scan).toThrow(/TOKEN_GLOBAL_OUTSIDE_SOURCE/)
  })

  it('媒体中的未消费全局定义仍拒绝', () => {
    const root = postcss.parse(
      '@media (prefers-color-scheme: dark) { :root { --new-token: 4px; } }',
      { from: 'src/styles/fixture-component.css' },
    )
    expect(() => [...sheetDecls(root)]).toThrow(/TOKEN_GLOBAL_OUTSIDE_SOURCE/)
  })

  it('唯一令牌源、局部定义及全局普通属性保留', () => {
    const source = postcss.parse(':root { --text-primary: 4px; }', {
      from: TOKEN_SHEET,
    })
    expect([...sheetDecls(source)]).toHaveLength(1)
    const root = postcss.parse(
      '.card { --text-primary: 4px; color: var(--text-primary) } body { color: currentcolor; } html .child { --local: 1px; }',
      { from: 'src/styles/fixture-component.css' },
    )
    expect([...sheetDecls(root)]).toHaveLength(4)
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual(['.card color: 4px'])
  })
})

const PROPERTY_RULE =
  '@property --text-primary { syntax: "<length>"; inherits: true; initial-value: 4px; }'

describe('@property 注册不能在令牌源之外改写全局令牌', () => {
  it.each([
    ['组件表', { from: 'src/styles/fixture-component.css' }],
    ['无来源夹具', {}],
  ])('%s 的注册即使无消费者也拒绝', (_label, opts) => {
    for (const css of [
      PROPERTY_RULE,
      PROPERTY_RULE.replace('@property', '@PROPERTY'),
      `@media (prefers-color-scheme: dark) { ${PROPERTY_RULE} }`,
    ]) {
      const root = postcss.parse(
        `${css} .a { color: var(--text-primary) }`,
        opts,
      )
      for (const scan of [
        () => [...sheetDecls(root)],
        () => danglingRefs(root, LIGHT_ENV),
        () => displayTypeErrors(root, LIGHT_ENV),
      ])
        expect(scan).toThrow(/TOKEN_GLOBAL_OUTSIDE_SOURCE/)
    }
  })

  it('令牌源内的注册尚未建模，取值与枚举入口均明确拒绝', () => {
    const css = `${PROPERTY_RULE} :root { --text-primary: #111; }`
    expect(() => tokenValuesOf(postcss.parse(css), LIGHT_ENV)).toThrow(
      /TOKEN_ROOT_AT_RULE_UNMODELED/,
    )
    const source = postcss.parse(css, { from: TOKEN_SHEET })
    expect(() => [...sheetDecls(source)]).toThrow(
      /TOKEN_ROOT_AT_RULE_UNMODELED/,
    )
  })
})

describe('颜色属性按结构分类进入展示色契约', () => {
  it.each([
    'text-emphasis-color',
    'text-emphasis',
    'scrollbar-color',
    '-webkit-text-fill-color',
    'stop-color',
  ])('%s 承载展示色', (prop) => expect(isDisplayColorProp(prop)).toBe(true))

  it.each([
    '--xy-controls-button-color',
    'color-scheme',
    'text-emphasis-style',
  ])('%s 不承载展示色', (prop) => expect(isDisplayColorProp(prop)).toBe(false))

  it('强调标记色消费尺寸令牌被点名，合法颜色与关键字形态通过', () => {
    const root = postcss.parse(
      '.a { text-emphasis-color: var(--radius-sm) }\n' +
        '.b { text-emphasis: filled var(--radius-sm) }\n' +
        '.c { text-emphasis-color: var(--text-primary); text-emphasis: open sesame var(--text-primary) }\n' +
        '.d { text-emphasis: filled double-circle; scrollbar-color: var(--text-primary) var(--surface-window) }',
    )
    expect(
      displayTypeErrors(root, LIGHT_ENV).map((e) => e.split(':')[0]),
    ).toEqual(['.a text-emphasis-color', '.b text-emphasis'])
  })
})

describe('自定义属性未建模 CSS-wide 值明确拒绝', () => {
  it.each(['unset', 'inherit', 'revert', 'revert-layer', 'UnSeT'])(
    '局部 %s 不能当作 color 的关键字放行',
    (value) => {
      const root = postcss.parse(
        `.a { --radius-sm: ${value}; color: var(--radius-sm, currentcolor) }`,
      )
      expect(() => danglingRefs(root, LIGHT_ENV)).toThrow(
        /TOKEN_CSS_WIDE_UNMODELED/,
      )
      expect(() => displayTypeErrors(root, LIGHT_ENV)).toThrow(
        /TOKEN_CSS_WIDE_UNMODELED/,
      )
    },
  )

  it.each(['inherit', 'revert', 'revert-layer'])(
    '根值 %s 的消费入口同样拒绝',
    (value) => {
      const tokens = tokenValuesOf(
        postcss.parse(`:root { --x: ${value}; }`),
        LIGHT_ENV,
      )
      const root = postcss.parse('.a { color: var(--x) }')
      const decl = [...sheetDecls(root)][0]!
      expect(() =>
        displayValueIn(decl, { env: LIGHT_ENV, tokens, locals: new Map() }),
      ).toThrow(/TOKEN_CSS_WIDE_UNMODELED/)
    },
  )

  it.each(['body', '*', '.parent'])(
    '%s 的 unset 也有继承来源，不能当文档根初值处理',
    (selector) => {
      const root = postcss.parse(
        `${selector} { --radius-sm: unset; } ${selector} .child { color: var(--radius-sm, currentcolor); }`,
      )
      expect(() => displayTypeErrors(root, LIGHT_ENV)).toThrow(
        /TOKEN_CSS_WIDE_UNMODELED/,
      )
    },
  )

  it('别名链与重要性胜出值不绕过拒绝', () => {
    const root = postcss.parse(
      '.a { --radius-sm: unset !important; --radius-sm: 4px; --alias: var(--radius-sm); color: var(--alias) }',
    )
    expect(() => displayTypeErrors(root, LIGHT_ENV)).toThrow(
      /TOKEN_CSS_WIDE_UNMODELED/,
    )
  })
})

describe('既有 CSS-wide 正常与恢复路径', () => {
  it.each([':root', 'html'])(
    '%s unset 仍为保证无效值，消费点回退接受/拒绝按类型',
    (selector) => {
      const css = `${selector} { --radius-sm: unset; } .a { color: var(--radius-sm, currentcolor) }`
      expect(danglingRefs(postcss.parse(css), LIGHT_ENV)).toEqual([])
      expect(displayTypeErrors(postcss.parse(css), LIGHT_ENV)).toEqual([])
      expect(
        displayTypeErrors(
          postcss.parse(css.replace('currentcolor', '4px')),
          LIGHT_ENV,
        ),
      ).toEqual(['.a color: 4px'])
    },
  )

  it('initial 保留回退，真实悬空仍报告', () => {
    const root = postcss.parse(
      '.a { --fg: initial; color: var(--fg, currentcolor) } .b { --fg: initial; color: var(--fg) }',
    )
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([])
    expect(danglingRefs(root, LIGHT_ENV)).toEqual([
      { selector: '.b', ref: '--fg' },
    ])
  })

  it('失活或被有效声明覆盖的未知值不影响当前胜出值', () => {
    const root = postcss.parse(
      '.a { --radius-sm: unset; --radius-sm: 4px; color: var(--radius-sm) } @media (prefers-color-scheme: dark) { .a { --radius-sm: inherit; } }',
    )
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual(['.a color: 4px'])
    expect(() =>
      displayTypeErrors(root, { ...LIGHT_ENV, scheme: 'dark' }),
    ).toThrow(/TOKEN_CSS_WIDE_UNMODELED/)
  })

  it.each(['unset', 'inherit', 'revert', 'revert-layer'])(
    '普通 color 的 %s 保持有效',
    (value) =>
      expect(
        displayTypeErrors(postcss.parse(`.a { color: ${value} }`), LIGHT_ENV),
      ).toEqual([]),
  )

  it('字符串中的继承词保持原值', () => {
    const root = postcss.parse(
      '.a { --label: "inherit"; content: var(--label) }',
    )
    const decl = [...sheetDecls(root)].find((item) => item.prop === 'content')!
    expect(
      displayValueIn(decl, {
        env: LIGHT_ENV,
        tokens: new Map(),
        locals: localDefinitions(root),
      }),
    ).toBe('"inherit"')
  })
})
