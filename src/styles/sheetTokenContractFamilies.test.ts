/**
 * PR #288 问题族回归：入口与相邻转换共用一份矩阵，见 docs/css-token-contract.md。
 * 期望值来自该文档所列 CSS 规范，不由被测解析器生成；真实 glob 另由 sheetTokens 覆盖。
 */
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import { colorTypeOk } from './cssColorContract'
import {
  danglingRefs,
  declOf,
  displayTypeErrors,
  displayValueIn,
  LIGHT_ENV,
  localDefinitions,
  scopeReaches,
  sheetDecls,
  tokenValuesOf,
  TOKEN_SHEET,
} from './sheetTokensEngine'

describe('F1 全局所有权：文档组合器与全部扫描入口', () => {
  it.each([
    'html > body',
    'html>body',
    ':root body',
    'HTML > BODY[data-theme="dark"]',
    '.unused, html > body',
    ':root > *',
    'html > body > *',
    'html[data-note="a > b"] > body',
  ])('F1-a 无消费者的 %s 在所有入口被拒绝', (selector) => {
    const root = postcss.parse(
      `@media (prefers-color-scheme: dark) { ${selector} { --text-primary: 4px; } }`,
      { from: 'src/styles/family-fixture.css' },
    )
    for (const scan of [
      () => [...sheetDecls(root)],
      () => localDefinitions(root),
      () => danglingRefs(root, LIGHT_ENV),
      () => displayTypeErrors(root, LIGHT_ENV),
    ])
      expect(scan).toThrow(/TOKEN_GLOBAL_OUTSIDE_SOURCE/)
  })

  it('F1-b 文档普通样式与局部后代定义保持可用', () => {
    const root = postcss.parse(
      'html > body { color: var(--text-primary); } html .card { --local: var(--text-primary); color: var(--local); } .card > * { --space: 4px; }',
      { from: 'src/styles/family-fixture.css' },
    )
    expect(danglingRefs(root, LIGHT_ENV)).toEqual([])
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([])
  })

  it.each(['html > body', 'html > body > *'])(
    'F1-b 令牌源也拒绝未建模的文档组合器 %s',
    (selector) => {
      const root = postcss.parse(
        `:root { --fg: #fff; } ${selector} { --fg: 4px; }`,
        { from: TOKEN_SHEET },
      )
      expect(() => tokenValuesOf(root, LIGHT_ENV)).toThrow(
        /TOKEN_ROOT_SELECTOR_UNMODELED/,
      )
    },
  )
})

describe('F2 层叠取胜：重要性规则覆盖全部拥有者', () => {
  it.each([false, true])(
    'F2-a 重要声明在前=%s 不改变四个入口的胜出值',
    (first) => {
      const values = first
        ? '--fg: #123456 !important; --fg: #ffffff;'
        : '--fg: #ffffff; --fg: #123456 !important;'
      const tokens = tokenValuesOf(
        postcss.parse(`:root { ${values} }`),
        LIGHT_ENV,
      )
      expect(tokens.get('--fg')).toBe('#123456')
      const root = postcss.parse(`.a { ${values} color: var(--fg); }`)
      const consumer = [...sheetDecls(root)].find(
        (decl) => decl.prop === 'color',
      )!
      expect(
        displayValueIn(consumer, {
          env: LIGHT_ENV,
          tokens,
          locals: localDefinitions(root),
        }),
      ).toBe('#123456')
      const rule = postcss.parse(`.a { ${values.replace(/--fg/g, 'color')} }`)
        .first as postcss.Rule
      expect(declOf(rule, 'color')).toBe('#123456')
      const important =
        '@media (prefers-color-scheme: dark) { .a { --fg: #123456 !important; } }'
      const ordinary = '.a { --fg: #ffffff; color: var(--fg); }'
      const mixed = postcss.parse(
        first ? important + ordinary : ordinary + important,
      )
      const target = [...sheetDecls(mixed)].find(
        (decl) => decl.prop === 'color',
      )!
      expect(
        displayValueIn(target, {
          env: { ...LIGHT_ENV, scheme: 'dark' },
          tokens: new Map(),
          locals: localDefinitions(mixed),
        }),
      ).toBe('#123456')
      expect(
        displayValueIn(target, {
          env: LIGHT_ENV,
          tokens: new Map(),
          locals: localDefinitions(mixed),
        }),
      ).toBe('#ffffff')
    },
  )
})

describe('F2-a 跨条件组按胜出声明的源序排序', () => {
  it.each([
    [
      '@media (prefers-color-scheme: dark) { .a { --fg: #fff !important; } }',
      '@media (prefers-contrast: more) { .a { --fg: 4px !important; } }',
      '@media (prefers-color-scheme: dark) { .a { --fg: #000; } }',
      '4px',
    ],
    [
      '@media (prefers-contrast: more) { .a { --fg: 4px !important; } }',
      '@media (prefers-color-scheme: dark) { .a { --fg: #fff !important; } }',
      '@media (prefers-contrast: more) { .a { --fg: #000; } }',
      '#fff',
    ],
    [
      '@media (prefers-color-scheme: dark) { .a { --fg: #fff !important; } }',
      '@media (prefers-contrast: more) { .a { --fg: 4px !important; } }',
      '@media (prefers-color-scheme: dark) { .a { --fg: #000 !important; } }',
      '#000',
    ],
  ])('跨条件组胜出值为 %s / %s / %s', (first, second, third, expected) => {
    const root = postcss.parse(
      `${first}${second}${third}.a { color: var(--fg) }`,
    )
    const env = {
      ...LIGHT_ENV,
      scheme: 'dark' as const,
      contrast: 'more' as const,
    }
    const color = [...sheetDecls(root)].find((decl) => decl.prop === 'color')!
    expect(
      displayValueIn(color, {
        env,
        tokens: new Map(),
        locals: localDefinitions(root),
      }),
    ).toBe(expected)
    expect(displayTypeErrors(root, env)).toEqual(
      expected === '4px' ? ['.a color: 4px'] : [],
    )
  })
})

describe('F2-a 失活条件与无效值恢复', () => {
  it('失活媒体不挪动赢家；保证无效的旧赢家可由另一活跃条件恢复', () => {
    const root = postcss.parse(
      '@media (prefers-color-scheme: dark) { .a { --fg: initial !important; } }' +
        '@media (prefers-contrast: more) { .a { --fg: 4px !important; } }' +
        '@media (prefers-color-scheme: dark) { .a { --fg: #fff; } }' +
        '.a { color: var(--fg, var(--text-primary)); }',
    )
    expect(
      displayTypeErrors(root, {
        ...LIGHT_ENV,
        scheme: 'dark',
        contrast: 'more',
      }),
    ).toEqual(['.a color: 4px'])
    expect(displayTypeErrors(root, { ...LIGHT_ENV, scheme: 'dark' })).toEqual(
      [],
    )
    expect(displayTypeErrors(root, { ...LIGHT_ENV, contrast: 'more' })).toEqual(
      ['.a color: 4px'],
    )
    expect(
      danglingRefs(root, { ...LIGHT_ENV, scheme: 'dark', contrast: 'more' }),
    ).toEqual([])
  })
})

describe('F2-b 简单子代链的空白写法不改变局部可达性', () => {
  it.each([
    ['.parent > .child', '.parent>.child .grand'],
    ['.parent>.child', '.parent > .child .grand'],
    ['.parent  >  .child', '.parent>.child'],
    ['.parent > .child', '.parent>.child:hover .grand'],
  ])('%s 定义可达 %s 的类型与引用入口', (definer, consumer) => {
    const root = postcss.parse(
      `${definer} { --fg: 4px; } ${consumer} { color: var(--fg, var(--text-primary)); }`,
    )
    expect(
      scopeReaches(localDefinitions(root).get('--fg')!, { selector: consumer }),
    ).toBe(true)
    expect(danglingRefs(root, LIGHT_ENV)).toEqual([])
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
      `${consumer} color: 4px`,
    ])
  })

  it('最近子代定义优先于远祖先重要声明，列表与兄弟仍各自判定', () => {
    const root = postcss.parse(
      '.parent { --fg: var(--text-primary) !important; }' +
        '.parent > .child { --fg: 4px; }' +
        '.parent>.child .grand { color: var(--fg); }',
    )
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
      '.parent>.child .grand color: 4px',
    ])
    const defs = localDefinitions(root).get('--fg')!
    const child = defs.filter((def) => def.selector.includes('>'))
    expect(
      scopeReaches(child, { selector: '.parent>.child .grand, .orphan' }),
    ).toBe(false)
    expect(scopeReaches(child, { selector: '.parent>.child + .grand' })).toBe(
      false,
    )
    expect(scopeReaches(child, { selector: '.parent>.childish .grand' })).toBe(
      false,
    )
  })

  it('属性值内的 > 原样保留，仅规范化外部子代组合器', () => {
    const root = postcss.parse(
      '.parent[data-note="a > b"] > .child { --fg: 4px; }',
    )
    const defs = localDefinitions(root).get('--fg')!
    expect(
      scopeReaches(defs, {
        selector: '.parent[data-note="a > b"]>.child .grand',
      }),
    ).toBe(true)
    expect(
      scopeReaches(defs, {
        selector: '.parent[data-note="a>b"]>.child .grand',
      }),
    ).toBe(false)
  })
})

describe('F2-d 根令牌的嵌套规则在取值前拒绝', () => {
  it.each([
    ':root { --fg: #fff; & { --fg: 4px; } }',
    ':root { & { --fg: 4px; } }',
    '.other, :root { &:hover, & { --fg: 4px !important; } }',
    ':root { & { & { --fg: 4px; } } }',
    ':root { @media (prefers-color-scheme: dark) { & { --fg: 4px; } } }',
    '@media (prefers-color-scheme: dark) { :root { & { --fg: 4px; } } }',
    ':root { & { @media (prefers-color-scheme: dark) { --fg: 4px; } } }',
    '.other { :root { --fg: 4px; } }',
  ])('嵌套根定义拒绝：%s', (css) => {
    const root = postcss.parse(css, { from: TOKEN_SHEET })
    // 错误码契约：docs/css-token-contract.md F2-d，不随媒体活跃性/消费者变化。
    for (const env of [LIGHT_ENV, { ...LIGHT_ENV, scheme: 'dark' as const }])
      expect(() => tokenValuesOf(root, env)).toThrow(
        /TOKEN_ROOT_NESTING_UNMODELED/,
      )
  })

  it('平铺根/外层媒体按环境取值，无根令牌的嵌套不改变范围', () => {
    const root = postcss.parse(
      ':root { --fg: #fff; & { color: red; } } @media (prefers-color-scheme: dark) { .other, :root { --fg: #000; } } .other { & { --local: 4px; } }',
      { from: TOKEN_SHEET },
    )
    expect(tokenValuesOf(root, LIGHT_ENV).get('--fg')).toBe('#fff')
    expect(
      tokenValuesOf(root, { ...LIGHT_ENV, scheme: 'dark' }).get('--fg'),
    ).toBe('#000')
  })
})

describe('F3 完整顶层值：未知词形不能被其他成分掩盖', () => {
  it.each([
    'not-a-color',
    'bad_value',
    '"solid"',
    'solid???',
    'solid not-a-color',
    'red not-a-color',
    'rgb(1, 2, 3) not-a-color',
    'transparent-junk',
    'url(a.svg) not-a-color',
    'linear-gradient(red, blue) not-a-color',
  ])('F3-a background 拒绝完整值 %s', (value) => {
    expect(colorTypeOk('background', value)).toBe(false)
    const root = postcss.parse(
      `.a { --paint: ${value}; background: var(--paint); }`,
    )
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
      `.a background: ${value}`,
    ])
  })

  it.each([
    ['background', 'none'],
    ['background', 'rgb(1, 2, 3)'],
    ['background', 'linear-gradient(red, blue) padding-box, #fff border-box'],
    ['background-image', 'repeating-linear-gradient(red, transparent)'],
    ['border', '1px solid currentcolor'],
    ['text-shadow', '0 1px 2px #fff'],
    ['text-decoration', 'line-through'],
    ['text-emphasis', 'filled sesame'],
    ['fill', 'url("#paint")'],
  ])('F3-a 合法对照 %s: %s', (prop, value) => {
    expect(colorTypeOk(prop, value)).toBe(true)
  })

  it('F3-b 媒体、重要性、根/局部别名和选中 fallback 共用完整值检查', () => {
    const root = postcss.parse(
      ':root { --paint: not-a-color; } .a { --paint: initial; } @media (prefers-color-scheme: dark) { .a { --paint: not-a-color !important; } } .a, .b { background: var(--paint, none); }',
    )
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
      '.b background: not-a-color',
    ])
    expect(displayTypeErrors(root, { ...LIGHT_ENV, scheme: 'dark' })).toEqual([
      '.a background: not-a-color',
      '.b background: not-a-color',
    ])
    expect(
      displayTypeErrors(
        postcss.parse(
          '.a { background: var(--missing, not-a-color); } .b { background: var(--text-primary, not-a-color); }',
        ),
        LIGHT_ENV,
      ),
    ).toEqual(['.a background: not-a-color'])
  })
})

describe.each(['background-image', 'border-image-source'])(
  'F3-c 图像长形 %s 的完整值',
  (prop) => {
    it.each([
      '#fff',
      'red',
      'rgb(255 255 255)',
      'transparent',
      'currentColor',
      'url(a.png) #fff',
      'none padding-box',
      '1px',
      'solid',
      ',url(a.png)',
      'url(a.png),,none',
      'url(a.png),',
    ])('拒绝非图像或空列表项：%s', (value) => {
      expect(colorTypeOk(prop, value)).toBe(false)
      const root = postcss.parse(
        `.a { --paint: ${value}; ${prop}: var(--paint); }`,
      )
      expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
        `.a ${prop}: ${value}`,
      ])
    })

    it.each([
      'none',
      'url("data:image/svg+xml,a,,b")',
      'repeating-radial-gradient(red, transparent)',
      'initial',
      'revert-layer',
    ])('保留合法单项或整值关键字：%s', (value) => {
      expect(colorTypeOk(prop, value)).toBe(true)
    })

    it.each(['url(a.png), none', 'linear-gradient(red, blue),url(b.png)'])(
      '列表个数由属性决定：%s',
      (value) => {
        expect(colorTypeOk(prop, value)).toBe(prop === 'background-image')
      },
    )
  },
)

describe.each(['background-image', 'border-image-source'])(
  'F3-c 图像长形 %s 的求值组合',
  (prop) => {
    it('局部别名、媒体重要性与 fallback 切换不改变图像类型', () => {
      const root = postcss.parse(
        `.a { --paint: url(a.png); --alias: var(--paint); ${prop}: var(--alias, #fff); }
         @media (prefers-color-scheme: dark) { .a { --paint: #fff !important; } }
         .b { ${prop}: var(--missing, #fff); }
         .c { ${prop}: var(--text-primary); }`,
      )
      expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
        `.b ${prop}: #fff`,
        expect.stringMatching(`^\\.c ${prop}: `),
      ])
      expect(displayTypeErrors(root, { ...LIGHT_ENV, scheme: 'dark' })).toEqual(
        [
          `.a ${prop}: #fff`,
          `.b ${prop}: #fff`,
          expect.stringMatching(`^\\.c ${prop}: `),
        ],
      )
    })
  },
)

describe('F3-d border-image 简写的已识别成分类型', () => {
  it.each([
    '#fff',
    'red',
    'transparent',
    'currentColor',
    'rgb(255 255 255)',
    'url(a.png) #fff',
    '#fff url(a.png)',
  ])('拒绝独立或混入图像的普通颜色：%s', (value) => {
    expect(colorTypeOk('border-image', value)).toBe(false)
    const root = postcss.parse(
      `.a { --paint: ${value}; border-image: var(--paint); }`,
    )
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
      `.a border-image: ${value}`,
    ])
  })

  it.each(['solid', 'url(a.png) solid', 'url(a.png) none', 'none url(a.png)'])(
    '拒绝通用边框关键字或互斥图像源：%s',
    (value) => {
      expect(colorTypeOk('border-image', value)).toBe(false)
      const root = postcss.parse(
        `.a { --paint: ${value}; border-image: var(--paint); }`,
      )
      expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
        `.a border-image: ${value}`,
      ])
    },
  )

  it.each([
    'url(a.png)',
    'url("data:image/svg+xml,red")',
    'url(a.png) 0',
    'linear-gradient(red, blue)',
    'none',
    'initial',
  ])('保留已支持图像源和整值关键字：%s', (value) =>
    expect(colorTypeOk('border-image', value)).toBe(true),
  )

  it('背景简写仍接受颜色；border-image 只检查选中值与活跃媒体', () => {
    expect(colorTypeOk('background', '#fff')).toBe(true)
    const root = postcss.parse(
      '.a { --paint: url(a.png); border-image: var(--paint, #fff); }' +
        '@media (prefers-color-scheme: dark) { .a { --paint: #fff !important; } }' +
        '.b { border-image: var(--missing, #fff); }',
    )
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
      '.b border-image: #fff',
    ])
    expect(displayTypeErrors(root, { ...LIGHT_ENV, scheme: 'dark' })).toEqual([
      '.a border-image: #fff',
      '.b border-image: #fff',
    ])
  })
})
