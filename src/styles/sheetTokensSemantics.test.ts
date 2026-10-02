/**
 * 全表 CSS 令牌契约的语义夹具（issue #278），与真实扫描共享 sheetTokensEngine。
 * F2 层叠、F3 类型、F5 引用的统一矩阵及支持/拒绝/保留边界见
 * docs/css-token-contract.md；保留已有根/局部/媒体/分支/恢复回归用例。
 */
import postcss from 'postcss'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { colorTypeOk, hasColorLiteral } from './cssColorContract'
import {
  conditionActive,
  danglingRefs,
  declOf,
  displayTypeErrors,
  displayValueIn,
  isDisplayColorProp,
  LIGHT_ENV,
  localDefinitions,
  normalizeProp,
  ruleIn,
  scopeReaches,
  sheetDecls,
  tokenValuesOf,
  unresolvedRefsIn,
  type Env,
  type LocalDef,
  type WiringCtx,
} from './sheetTokensEngine'

describe('展示色结构：属性与字面探测分类（issue #278）', () => {
  it('展示色属性分类覆盖 border 全部简写/长形（四向与逻辑方向）、border-image、SVG fill/stroke、background-image 与 text-shadow；box-shadow 与尺寸类不算', () => {
    for (const prop of [
      'border',
      'border-top',
      'border-left',
      'border-inline-start',
      'border-block-end-color',
      'border-color',
      'border-image',
      'border-image-source',
      'outline',
      'fill',
      'stroke',
      'background',
      'background-color',
      'background-image',
      'text-shadow',
    ]) {
      expect(isDisplayColorProp(prop), prop).toBe(true)
    }
    for (const prop of [
      'box-shadow',
      'border-width',
      'border-radius',
      'border-top-width',
      'border-image-width',
      'border-image-slice',
      'mask-image',
      'padding',
    ]) {
      expect(isDisplayColorProp(prop), prop).toBe(false)
    }
  })
  it('字面色探测覆盖 hex/大小写不敏感函数色/具名色；transparent、currentcolor、none、var() 名内的色词不算', () => {
    expect(hasColorLiteral('#fff')).toBe(true)
    expect(hasColorLiteral('rgba(0, 0, 0, 0.68)')).toBe(true)
    expect(hasColorLiteral('RGB(255, 0, 0)'), 'CSS 函数名大小写不敏感').toBe(
      true,
    )
    expect(hasColorLiteral('white')).toBe(true)
    expect(hasColorLiteral('1px solid Red')).toBe(true)
    expect(hasColorLiteral('linear-gradient(transparent, black)')).toBe(true)
    expect(hasColorLiteral('2px solid transparent')).toBe(false)
    expect(hasColorLiteral('currentcolor')).toBe(false)
    expect(hasColorLiteral('none')).toBe(false)
    expect(hasColorLiteral('inherit')).toBe(false)
    expect(hasColorLiteral('var(--danger-red)')).toBe(false)
    expect(hasColorLiteral('1px solid var(--border-hairline)')).toBe(false)
  })

  it('标准属性名 ASCII 大小写不敏感地归一分类；自定义属性名大小写保持原样不被归一', () => {
    expect(normalizeProp('Color')).toBe('color')
    expect(normalizeProp('BACKGROUND-Color')).toBe('background-color')
    expect(normalizeProp('--My-Token')).toBe('--My-Token')
    const root = postcss.parse('.x { Color: #fff; Background: none; }')
    const decls = [...sheetDecls(root)]
    expect(decls.map((d) => d.prop)).toEqual(['color', 'background'])
  })
})

describe('组件声明上下文拒绝边界（review 5280077466）', () => {
  it.each([
    '.card { &:hover { color: #fff; } }',
    '.card { .child { color: var(--missing); } }',
    '.card { @media (prefers-color-scheme: dark) { color: 4px; } }',
    '.card { @supports (display: grid) { --fg: 4px; } }',
    '@media (prefers-color-scheme: dark) { .card { & { color: #fff; } } }',
  ])('嵌套布局在所有扫描入口明确失败：%s', (css) => {
    const root = postcss.parse(css)
    // 错误码契约：docs/css-token-contract.md F2 上下文拒绝边界。
    for (const scan of [
      () => [...sheetDecls(root)],
      () => localDefinitions(root),
      () => danglingRefs(root, LIGHT_ENV),
      () => displayTypeErrors(root, LIGHT_ENV),
    ]) {
      expect(scan).toThrow(/TOKEN_SHEET_NESTING_UNMODELED/)
    }
  })

  it.each([
    '@supports (display: unsupported)',
    '@container (width > 400px)',
    '@layer theme',
    '@keyframes pulse',
    '@media (prefers-color-scheme: dark) { @supports (display: grid)',
  ])('未知局部定义上下文不能成为无条件值：%s', (context) => {
    const closing = context.includes('{') ? '} }' : '}'
    const root = postcss.parse(
      `${context} { .card { --fg: var(--text-primary); } ${closing}
       .card { color: var(--fg, currentcolor); }`,
    )
    // 错误码契约同上；即使消费有回退或未知块不活跃，也不能静默接受。
    for (const scan of [
      () => [...sheetDecls(root)],
      () => localDefinitions(root),
      () => danglingRefs(root, LIGHT_ENV),
      () => displayTypeErrors(root, LIGHT_ENV),
    ]) {
      expect(scan).toThrow(/TOKEN_LOCAL_AT_RULE_UNMODELED/)
    }
  })
})

describe('已支持组件上下文保持生效（review 5280077466）', () => {
  it('平铺、外层媒体及动画声明保留原上下文', () => {
    const root = postcss.parse(`
      .card { color: currentcolor !important; }
      @media (prefers-color-scheme: dark) { .card { color: transparent; } }
      @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    `)
    expect([...sheetDecls(root)]).toEqual([
      {
        selector: '.card',
        condition: '',
        prop: 'color',
        value: 'currentcolor',
        important: true,
      },
      {
        selector: '.card',
        condition: '@media (prefers-color-scheme: dark);',
        prop: 'color',
        value: 'transparent',
        important: false,
      },
      {
        selector: 'from',
        condition: '@keyframes fade;',
        prop: 'opacity',
        value: '0',
        important: false,
      },
      {
        selector: 'to',
        condition: '@keyframes fade;',
        prop: 'opacity',
        value: '1',
        important: false,
      },
    ])
  })
})

describe('局部上下文的条件与恢复（review 5280077466）', () => {
  it.each(['media', 'MEDIA'])('局部 @%s 定义按环境选值及回退', (name) => {
    const root = postcss.parse(`
      @${name} (prefers-color-scheme: dark) { .card { --fg: 4px; } }
      .card { color: var(--fg, currentcolor); }
    `)
    expect(danglingRefs(root, LIGHT_ENV)).toEqual([])
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([])
    expect(displayTypeErrors(root, { ...LIGHT_ENV, scheme: 'dark' })).toEqual([
      '.card color: 4px',
    ])
    const invalidFallback = postcss.parse(
      root.toString().replace('currentcolor', '8px'),
    )
    expect(displayTypeErrors(invalidFallback, LIGHT_ENV)).toEqual([
      '.card color: 8px',
    ])
  })

  it('未知局部上下文即使未消费也拒绝，无局部定义时可枚举', () => {
    const root = postcss.parse(
      '@supports (display: grid) { .card { --unused: 4px; } }',
    )
    expect(() => localDefinitions(root)).toThrow(
      /TOKEN_LOCAL_AT_RULE_UNMODELED/,
    )
    expect([
      ...sheetDecls(
        postcss.parse(
          '@supports (display: grid) { .card { color: currentcolor; } }',
        ),
      ),
    ]).toHaveLength(1)
  })
})

describe('字面色检测忽略 URL 与字符串内容（review 5280077466）', () => {
  it.each([
    "url('/assets/white-logo.svg')",
    "url('/assets/white.svg')",
    'url(/assets/red.svg)',
    'URL("/assets/blue.svg#fff")',
    'url("data:image/svg+xml,<svg fill=\'#fff\'/>")',
    'url("/assets/rgb(0,0,0).svg")',
    '"white #fff rgb(0,0,0)"',
    String.raw`url("/assets/escaped\"white).svg")`,
    String.raw`url(/assets/escaped\)white.svg)`,
    String.raw`"escaped\" white"`,
    'image-set("/white.svg" 1x, url(/red.svg) 2x)',
    'url(/white.svg), linear-gradient(transparent, currentcolor)',
  ])('不把不透明内容当颜色：%s', (value) => {
    expect(hasColorLiteral(value)).toBe(false)
  })

  it.each([
    'url(/white.svg), linear-gradient(transparent, black)',
    'url("/red.svg") #fff',
    '"white" rgb(0,0,0)',
    String.raw`url("/escaped\"white).svg") blue`,
    String.raw`url(/escaped\)white.svg) red`,
    'var(--image, linear-gradient(white, transparent))',
    'image-set(url(/white.svg) 1x, linear-gradient(red, transparent) 2x)',
  ])('仍检查 URL 或字符串之外的真实颜色：%s', (value) => {
    expect(hasColorLiteral(value)).toBe(true)
  })
})

describe('指定值先于继承值（review 5279748560）', () => {
  it.each([
    ['.parent', '.parent .child'],
    ['.parent', '.parent > .child'],
    ['.parent', '.parent>.child'],
    [':root', '.parent .child'],
    ['body', '.parent .child'],
    ['html', '.parent .child'],
    ['.parent, .unrelated', '.parent .child'],
  ])('%s 的重要值不能覆盖 %s 自身的指定值', (ancestor, child) => {
    for (const reverse of [false, true]) {
      const rules = [
        `${child} { --fg: 4px; color: var(--fg); }`,
        `${ancestor} { --fg: var(--text-primary) !important; }`,
      ]
      if (reverse) rules.reverse()
      expect(
        displayTypeErrors(postcss.parse(rules.join('\n')), LIGHT_ENV),
      ).toEqual([`${child} color: 4px`])
    }
  })

  it.each([
    ['.parent .middle { --fg: 4px; }', '.parent .middle .child'],
    ['* { --fg: 4px; }', '.parent .child'],
  ])('最近祖先或通配指定值先于远祖先：%s', (nearest, consumer) => {
    const root = postcss.parse(
      `${nearest} .parent { --fg: var(--text-primary) !important; } ${consumer} { color: var(--fg); }`,
    )
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
      `${consumer} color: 4px`,
    ])
  })

  it('复合选择器延续仍是同一元素，继续比较重要性', () => {
    const root = postcss.parse(
      '.parent .child { --fg: 4px !important; } .parent .child.active { --fg: var(--text-primary); color: var(--fg); }',
    )
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
      '.parent .child.active color: 4px',
    ])
  })

  it('有效自身值不被祖先无效值污染', () => {
    const root = postcss.parse(
      '.parent .child { --fg: var(--text-primary); color: var(--fg); } .parent { --fg: initial !important; }',
    )
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([])
    expect(danglingRefs(root, LIGHT_ENV)).toEqual([])
  })
})

describe('继承选择的环境与恢复（review 5279748560）', () => {
  it('按媒体环境和逗号分支独立选择，缺少自身定义时继承', () => {
    const root = postcss.parse(
      '@media (prefers-color-scheme: dark) { .parent .a { --fg: 4px; } }' +
        '.parent { --fg: var(--text-primary) !important; } .parent .a, .parent .b { color: var(--fg); }',
    )
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([])
    expect(displayTypeErrors(root, { ...LIGHT_ENV, scheme: 'dark' })).toEqual([
      '.parent .a color: 4px',
    ])
  })

  it.each(['initial', 'var(--missing)'])(
    '最近定义 %s 失效不能回头使用祖先同名值',
    (value) => {
      const root = postcss.parse(
        `.parent .child { --fg: ${value}; color: var(--fg); } .parent { --fg: var(--text-primary) !important; }`,
      )
      expect(danglingRefs(root, LIGHT_ENV)).toContainEqual({
        selector: '.parent .child',
        ref: '--fg',
      })
    },
  )

  it.each([
    ['initial', 'currentcolor', false],
    ['initial', '4px', true],
    ['var(--missing)', 'currentcolor', false],
    ['var(--missing)', '4px', true],
  ])('最近定义 %s 使用回退 %s', (value, fallback, invalid) => {
    const root = postcss.parse(
      `.parent .child { --fg: ${value}; color: var(--fg, ${fallback}); } .parent { --fg: var(--text-primary) !important; }`,
    )
    const ctx: WiringCtx = {
      env: LIGHT_ENV,
      tokens: new Map([['--text-primary', '#fff']]),
      locals: localDefinitions(root),
    }
    const consumer = [...sheetDecls(root)].find(
      (decl) => decl.prop === 'color',
    )!
    expect(displayValueIn(consumer, ctx)).toBe(fallback)
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual(
      invalid ? ['.parent .child color: 4px'] : [],
    )
  })
})

describe('根令牌上下文边界（review 5279748560）', () => {
  it.each([
    '@supports (display: grid)',
    '@layer theme',
    '@container (width > 400px)',
    '@media (prefers-color-scheme: dark) { @supports (display: grid)',
  ])('%s 中的根令牌显式拒绝，不返回跳过入口的值', (context) => {
    const closing = context.includes('{') ? '} }' : '}'
    const root = postcss.parse(
      `:root { --fg: #fff; } ${context} { :root { --fg: 4px; } ${closing}`,
    )
    // 错误码契约：docs/css-token-contract.md F2 根上下文拒绝边界。
    expect(() => tokenValuesOf(root, LIGHT_ENV)).toThrow(
      /TOKEN_ROOT_AT_RULE_UNMODELED/,
    )
  })

  it.each(['supports (display: grid)', 'media (prefers-color-scheme: dark)'])(
    '根规则内部嵌套 @%s 的声明布局同样显式拒绝',
    (context) => {
      const root = postcss.parse(
        `:root { --fg: #fff; @${context} { --fg: 4px; } }`,
      )
      // 错误码契约同本组：不能通过改变根规则与条件块的嵌套方向绕过上下文检查。
      expect(() => tokenValuesOf(root, LIGHT_ENV)).toThrow(
        /TOKEN_ROOT_AT_RULE_UNMODELED/,
      )
    },
  )

  it.each([
    '@supports (display: grid) { .other { --fg: 4px; } }',
    '@supports (display: grid) { :root { color: #fff; } }',
    '@layer theme;',
  ])('不含根令牌的其他上下文不改变根值：%s', (extra) => {
    const root = postcss.parse(`:root { --fg: #fff; } ${extra}`)
    expect(tokenValuesOf(root, LIGHT_ENV).get('--fg')).toBe('#fff')
  })

  it.each(['media', 'MEDIA'])('已支持的 @%s 按环境取值', (name) => {
    const root = postcss.parse(
      `:root { --fg: #fff; } @${name} (prefers-color-scheme: dark) { :root { --fg: 4px; } }`,
    )
    expect(tokenValuesOf(root, LIGHT_ENV).get('--fg')).toBe('#fff')
    expect(
      tokenValuesOf(root, { ...LIGHT_ENV, scheme: 'dark' }).get('--fg'),
    ).toBe('4px')
  })
})

describe('展示色类型：图像属性文法（review 5275666509）', () => {
  it.each([
    'border',
    'border-inline-start',
    'outline',
    'text-decoration',
    'column-rule',
    'text-shadow',
  ])('%s 拒绝渐变和 URL，不能借图像中的颜色成分通过校验', (prop) => {
    for (const value of ['var(--brand-gradient)', 'url("fixture.svg")']) {
      const root = postcss.parse(
        `.a { --image: ${value}; ${prop}: var(--image) }`,
      )
      expect(displayTypeErrors(root, LIGHT_ENV)).toHaveLength(1)
    }
  })
  it('背景与 border-image 接受图像，SVG paint 接受 URL 引用但拒绝 CSS 渐变', () => {
    for (const prop of [
      'background',
      'background-image',
      'border-image',
      'border-image-source',
      'fill',
      'stroke',
    ]) {
      const root = postcss.parse(
        `.a { --paint: url("#paint"); ${prop}: var(--paint) }`,
      )
      expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([])
    }
    for (const prop of [
      'background',
      'background-image',
      'border-image',
      'border-image-source',
    ]) {
      expect(
        displayTypeErrors(
          postcss.parse(`.a { ${prop}: var(--brand-gradient) }`),
          LIGHT_ENV,
        ),
      ).toEqual([])
    }
    for (const prop of ['color', 'fill', 'stroke']) {
      expect(
        displayTypeErrors(
          postcss.parse(`.a { ${prop}: var(--brand-gradient) }`),
          LIGHT_ENV,
        ),
      ).toHaveLength(1)
    }
  })
})

describe('展示色类型：fallback 取值（review 5275666509）', () => {
  it.each([
    ['', 'var(--missing, 4px)'],
    ['', 'var(--missing,)'],
    ['', 'var(--missing, var(--also-missing, 600))'],
    ['--provided: 4px;', 'var(--provided, var(--text-primary))'],
    ['--invalid: initial;', 'var(--invalid, 4px)'],
    ['--alias: var(--missing);', 'var(--alias, 4px)'],
    ['--loop: var(--loop);', 'var(--loop, 4px)'],
    ['--loop: var(--loop, var(--text-primary));', 'var(--loop, 4px)'],
    ['--a: var(--b, var(--text-primary)); --b: var(--a);', 'var(--a, 4px)'],
  ])(
    '无效变量选择的 fallback 仍须符合消费属性：%s %s',
    (definitions, value) => {
      const root = postcss.parse(`.a { ${definitions} color: ${value} }`)
      expect(displayTypeErrors(root, LIGHT_ENV)).toHaveLength(1)
    },
  )
  it.each([
    ['', 'var(--missing, var(--text-primary))'],
    ['', 'var(--missing, rgb(1, 2, 3))'],
    ['', 'var(--text-primary, 4px)'],
    ['--invalid: initial;', 'var(--invalid, var(--text-primary))'],
    ['--loop: var(--loop);', 'var(--loop, var(--text-primary))'],
  ])(
    '只校验生效值，有效主值或 fallback 继续通过：%s %s',
    (definitions, value) => {
      const root = postcss.parse(`.a { ${definitions} color: ${value} }`)
      const decl = [...sheetDecls(root)].find(
        (entry) => entry.prop === 'color',
      )!
      const ctx = {
        env: LIGHT_ENV,
        tokens: tokenValuesOf(postcss.parse(readTokensSheet()), LIGHT_ENV),
        locals: localDefinitions(root),
      }
      expect(displayValueIn(decl, ctx)).not.toBeNull()
      expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([])
    },
  )
})

/**
 * 真实 tokens.css 文本：本文件仅此一处用例需要真实令牌值链（校验含
 * `--text-primary` 的 fallback 生效值），其余测试均用合成 postcss 夹具。
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
function readTokensSheet(): string {
  return readFileSync(join(repoRoot, 'src/styles/tokens.css'), 'utf8')
}

describe('展示色类型：逐选择器分支取值（review 5275666509）', () => {
  it('同名局部变量分别遮蔽根令牌，逐分支报告实际无效值', () => {
    const root = postcss.parse(
      '.a { --text-primary: 4px } .b { --text-primary: 600 } .a, .b { color: var(--text-primary) }',
    )
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
      '.a color: 4px',
      '.b color: 600',
    ])
  })
  it('保留有效局部分支和根令牌回退，只报告当前环境的无效分支', () => {
    const root = postcss.parse(
      '.a { --text-primary: var(--danger) } @media (prefers-color-scheme: dark) { .b { --text-primary: 600 } } .a, .b, .c { color: var(--text-primary) }',
    )
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([])
    expect(displayTypeErrors(root, { ...LIGHT_ENV, scheme: 'dark' })).toEqual([
      '.b color: 600',
    ])
  })
})

describe('接线实际取值路径（review 5275978899）', () => {
  it.each([
    ['', 'var(--text-primary, var(--missing))', []],
    ['--alias: var(--text-primary, var(--missing));', 'var(--alias)', []],
    ['', 'var(--missing, var(--text-primary, var(--other)))', []],
    [
      '--text-primary: initial;',
      'var(--text-primary, var(--missing))',
      ['--missing'],
    ],
    ['', 'var(--missing, var(--other))', ['--other']],
    [
      '--cycle: var(--cycle, var(--text-primary));',
      'var(--cycle, currentcolor)',
      [],
    ],
  ])('只校验选中路径：%s %s', (definitions, value, expected) => {
    const root = postcss.parse(
      `:root { ${definitions} } .target { color: ${value} }`,
    )
    const errors = danglingRefs(root, LIGHT_ENV).filter(
      (hit) => hit.selector === '.target',
    )
    expect(errors.map((hit) => hit.ref)).toEqual(expected)
  })
  it('主值按媒体环境和选择器分支切换时，fallback 随实际生效状态选择', () => {
    const root = postcss.parse(
      '@media (prefers-color-scheme: dark) { .a { --text-primary: initial } } .a, .b { color: var(--text-primary, var(--missing)) }',
    )
    expect(danglingRefs(root, LIGHT_ENV)).toEqual([])
    expect(danglingRefs(root, { ...LIGHT_ENV, scheme: 'dark' })).toEqual([
      { selector: '.a, .b', ref: '--missing' },
    ])
  })
})

describe('完整纯颜色值（review 5275978899）', () => {
  it.each([
    ['color', '#fff 4px', false],
    ['color', '4px #fff', false],
    ['color', 'rgb(1, 2, 3) 600', false],
    ['color', 'red invalid', false],
    ['color', '#fff #000', false],
    ['background-color', 'currentcolor 4px', false],
    ['outline-color', 'transparent 600', false],
    ['stroke', '#fff 4px', false],
    ['color', 'rgb(1, 2, 3)', true],
    ['color', 'inherit', true],
    ['border-color', '#fff rgb(1, 2, 3) transparent currentcolor', true],
    ['border-inline-color', '#fff #000', true],
    ['fill', 'none', true],
    ['border', '1px solid #fff', true],
    ['text-shadow', '0 1px 2px #fff', true],
  ])('%s: %s 的完整类型结果为 %s', (prop, value, expected) => {
    expect(colorTypeOk(prop, value)).toBe(expected)
  })
  it('根级别名的颜色与多余尺寸一起到达消费点时仍报错', () => {
    const root = postcss.parse(
      ':root { --bad: var(--text-primary) 4px } .target { color: var(--bad) }',
    )
    expect(displayTypeErrors(root, LIGHT_ENV)).toHaveLength(1)
  })
  it('没有展示色的布局、动画或空样式表仍可被扫描', () => {
    for (const css of [
      '',
      '.layout { display: grid }',
      '@keyframes move { to { transform: translateX(1px) } }',
    ]) {
      expect(displayTypeErrors(postcss.parse(css), LIGHT_ENV)).toEqual([])
      expect(danglingRefs(postcss.parse(css), LIGHT_ENV)).toEqual([])
    }
  })
})

describe('接线语义：作用域与分支可达（issue #278）', () => {
  it('局部自定义属性仅对定义规则自身/后代可达；逗号选择器逐分支判定，任一分支不可达即假', () => {
    const def = (selector: string): LocalDef => ({
      selector,
      condition: '',
      value: '#000',
      important: false,
    })
    const definers = [def('.react-flow__controls')]
    const at = (selector: string) => ({ selector })
    expect(scopeReaches(definers, at('.react-flow__controls'))).toBe(true)
    expect(scopeReaches(definers, at('.react-flow__controls:hover'))).toBe(true)
    expect(scopeReaches(definers, at('.react-flow__controls > button'))).toBe(
      true,
    )
    expect(scopeReaches(definers, at('.react-flow__controls>button'))).toBe(
      true,
    )
    expect(
      scopeReaches(
        definers,
        at('.react-flow__controls .x, .react-flow__controls .y'),
      ),
      '每一分支均可达',
    ).toBe(true)
    expect(
      scopeReaches(definers, at('.react-flow__controls .x, .y')),
      '.y 分支不可达即整条不可达',
    ).toBe(false)
    expect(scopeReaches([def(':root')], at('.anything'))).toBe(true)
    expect(scopeReaches(definers, at('.react-flow__controls-button'))).toBe(
      false,
    )
    expect(scopeReaches(definers, at('.react-flow__controls + .x'))).toBe(false)
    expect(scopeReaches(definers, at('.unrelated'))).toBe(false)
  })

  it('逗号选择器逐分支校验在真实解析中生效：任一分支无可达定义即悬空（该分支运行时计算色失效）', () => {
    const root = postcss.parse(
      '.parent { --local: var(--text-primary); }\n' +
        '.parent .child, .orphan { color: var(--local); }',
    )
    expect(danglingRefs(root, LIGHT_ENV)).toEqual([
      { selector: '.parent .child, .orphan', ref: '--local' },
    ])
  })

  it('同选择器同条件的重复定义按层叠取后位：后位 initial 生效即悬空（先位有效定义不遮蔽）', () => {
    const root = postcss.parse(
      '.card { --fg: var(--text-primary); }\n' +
        '.card { --fg: initial; color: var(--fg); }',
    )
    expect(danglingRefs(root, LIGHT_ENV)).toEqual([
      { selector: '.card', ref: '--fg' },
    ])
  })
})

describe('接线语义：局部定义的级联取胜（issue #278）', () => {
  it('同选择器同条件内 !important 局部定义优先于其后的普通定义（源序不再单独决定生效值）', () => {
    const root = postcss.parse(
      '.a { --fg: 4px !important; --fg: var(--text-primary); color: var(--fg) }',
    )
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual(['.a color: 4px'])
  })

  it('后续基线定义按其源序位置生效，不被同名媒体块定义按 Map 键插入位置错误提前', () => {
    const root = postcss.parse(
      '.a { --fg: red; }\n' +
        '@media (prefers-color-scheme: dark) { .a { --fg: initial; } }\n' +
        '.a { --fg: var(--text-primary); color: var(--fg) }',
    )
    expect(danglingRefs(root, { ...LIGHT_ENV, scheme: 'dark' })).toEqual([])
  })

  it('跨活跃条件分组仍按重要性优先于源序取胜：媒体块内 !important 不因条件早于无条件后位定义而被覆盖', () => {
    const root = postcss.parse(
      '@media (prefers-color-scheme: dark) { .a { --fg: 4px !important; } }\n' +
        '.a { --fg: var(--text-primary); color: var(--fg) }',
    )
    const darkEnv: Env = { ...LIGHT_ENV, scheme: 'dark' }
    expect(
      displayTypeErrors(root, darkEnv),
      '暗色下 4px 生效且类型不相容',
    ).toEqual(['.a color: 4px'])
    expect(
      displayTypeErrors(root, LIGHT_ENV),
      '浅色下媒体块不活跃，回退到无条件普通定义',
    ).toEqual([])
  })

  it('局部同名定义遮蔽根令牌：遮蔽定义保证无效即悬空，有效遮蔽按局部值放行', () => {
    const invalid = postcss.parse(
      '.card { --text-primary: initial; color: var(--text-primary); }',
    )
    expect(danglingRefs(invalid, LIGHT_ENV)).toEqual([
      { selector: '.card', ref: '--text-primary' },
    ])
    const valid = postcss.parse(
      '.card { --text-primary: var(--danger); color: var(--text-primary); }',
    )
    expect(danglingRefs(valid, LIGHT_ENV)).toEqual([])
  })

  it('无空白子代组合器与带空白形式同样继承祖先遮蔽（review 5286056434）', () => {
    for (const child of ['.parent>.child', '.parent > .child']) {
      const root = postcss.parse(
        `.parent { --text-primary: 4px } ${child} { color: var(--text-primary) }`,
      )
      expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
        `${child} color: 4px`,
      ])
    }
  })
})

describe('接线语义：条件环境（issue #278）', () => {
  it('at-rule 条件链按环境求值：无条件恒真，单特性与多特性链按 env 逐一判定', () => {
    const dark = '@media (prefers-color-scheme: dark);'
    const darkMore = `${dark}@media (prefers-contrast: more);`
    const motion = '@media (prefers-reduced-motion: reduce);'
    const darkEnv: Env = { ...LIGHT_ENV, scheme: 'dark' }
    const darkMoreEnv: Env = { ...darkEnv, contrast: 'more' }
    const reduceMotionEnv: Env = { ...LIGHT_ENV, motion: 'reduce' }
    expect(conditionActive('', LIGHT_ENV)).toBe(true)
    expect(conditionActive(dark, LIGHT_ENV)).toBe(false)
    expect(conditionActive(dark, darkEnv)).toBe(true)
    expect(conditionActive(darkMore, darkEnv), '链上 AND 语义').toBe(false)
    expect(conditionActive(darkMore, darkMoreEnv)).toBe(true)
    expect(conditionActive(motion, LIGHT_ENV)).toBe(false)
    expect(conditionActive(motion, reduceMotionEnv)).toBe(true)
  })

  it('基线动效按 CSS 关键字 no-preference 生效，块内违例被扫描（review 5286056434）', () => {
    const root = postcss.parse(
      '@media (prefers-reduced-motion: no-preference) { .a { color: var(--radius-sm) } }',
    )
    expect(displayTypeErrors(root, LIGHT_ENV)).toHaveLength(1)
    expect(displayTypeErrors(root, { ...LIGHT_ENV, motion: 'reduce' })).toEqual(
      [],
    )
  })

  it.each([
    'prefers-reduced-motion: no-reduce',
    'prefers-contrast: less',
    'prefers-color-scheme: sepia',
  ])('未建模的媒体取值 (%s) 明确拒绝，不静默失活', (feature) =>
    expect(() => conditionActive(`@media (${feature});`, LIGHT_ENV)).toThrow(
      /TOKEN_MEDIA_VALUE_UNMODELED/,
    ),
  )

  it('仅在部分环境成立的定义对其他环境下的活跃引用判悬空（逐环境验证）', () => {
    const root = postcss.parse(
      '@media (prefers-color-scheme: light) { .card { --only-light: #000 } }\n' +
        '.card { color: var(--only-light) }',
    )
    const envOf = (scheme: 'light' | 'dark'): Env => ({
      ...LIGHT_ENV,
      scheme,
    })
    expect(danglingRefs(root, envOf('light')), '浅色下定义活跃且可达').toEqual(
      [],
    )
    expect(danglingRefs(root, envOf('dark')), '深色下定义不成立').toEqual([
      { selector: '.card', ref: '--only-light' },
    ])
  })

  it('媒体块内定义/引用在真实解析中按环境判定（无条件引用在浅色悬空，同块引用仅深色可解析）', () => {
    const root = postcss.parse(
      '@media (prefers-color-scheme: dark) { .card { --local: #000; } }\n' +
        '.card { color: var(--local); }\n' +
        '@media (prefers-color-scheme: dark) { .card p { color: var(--local); } }',
    )
    const envOf = (scheme: 'light' | 'dark'): Env => ({
      ...LIGHT_ENV,
      scheme,
    })
    expect(danglingRefs(root, envOf('dark'))).toEqual([])
    expect(danglingRefs(root, envOf('light'))).toEqual([
      { selector: '.card', ref: '--local' },
    ])
  })
})

describe('接线语义：值链与无效形态（issue #278）', () => {
  it('值链断裂的局部定义在消费点也判悬空（递归消解，不只查名存在）', () => {
    const root = postcss.parse(
      '.b { --chain: var(--missing); color: var(--chain); }',
    )
    expect(danglingRefs(root, LIGHT_ENV)).toEqual([
      { selector: '.b', ref: '--missing' },
      { selector: '.b', ref: '--chain' },
    ])
  })

  it('tokens.css 值链断裂的令牌在其消费点判悬空（定义源不在组件扫描内，由链消解兜住）', () => {
    const broken: WiringCtx = {
      env: LIGHT_ENV,
      tokens: tokenValuesOf(
        postcss.parse(':root { --a: var(--b); }'),
        LIGHT_ENV,
      ),
      locals: new Map(),
    }
    const intact: WiringCtx = {
      env: LIGHT_ENV,
      tokens: tokenValuesOf(
        postcss.parse(':root { --a: var(--b); --b: #fff; }'),
        LIGHT_ENV,
      ),
      locals: new Map(),
    }
    const at = {
      selector: '.x',
      condition: '',
      prop: 'color',
      value: 'var(--a)',
      important: false,
    }
    expect(unresolvedRefsIn(at, broken), '链断裂').toEqual(['--a'])
    expect(unresolvedRefsIn(at, intact), '链完整').toEqual([])
  })

  it('根令牌（:root）同名声明含 !important 时优先于普通声明取胜，无论源序', () => {
    const winsImportant = tokenValuesOf(
      postcss.parse(':root { --fg: 4px !important; --fg: #fff; }'),
      LIGHT_ENV,
    )
    expect(winsImportant.get('--fg')).toBe('4px')
    const laterImportantWins = tokenValuesOf(
      postcss.parse(':root { --fg: #fff !important; --fg: 4px !important; }'),
      LIGHT_ENV,
    )
    expect(laterImportantWins.get('--fg'), '同重要性仍取源序最后一条').toBe(
      '4px',
    )
  })

  it('保证无效形态的定义在消费点判悬空（initial 恒无效；文档根 unset 退化同判）', () => {
    const root = postcss.parse(
      '.a { --fg-init: initial; color: var(--fg-init); }\n' +
        '.b { --fg-ok: #fff; color: var(--fg-ok); }\n' +
        ':root { --root-unset: unset; }\n.c { color: var(--root-unset); }',
    )
    expect(danglingRefs(root, LIGHT_ENV)).toEqual([
      { selector: '.a', ref: '--fg-init' },
      { selector: '.c', ref: '--root-unset' },
    ])
  })
})

describe('黄金接线语义（生效值规则，issue #278）', () => {
  it.each([
    [
      '同属性后置声明不被前置声明遮蔽（CSS 最后声明生效）',
      '.x { color: var(--on-danger); color: var(--text-primary); }',
    ],
    [
      '!important 声明优先于其后的普通声明（源序不再单独决定）',
      '.x { color: var(--text-primary) !important; color: var(--on-danger); }',
    ],
    [
      '属性名大小写不敏感（后续非标准大小写声明仍被识别为同属性）',
      '.x { color: var(--on-danger); Color: var(--text-primary); }',
    ],
  ])('黄金接线按生效值规则取值：%s', (_label, css) => {
    const rule = postcss.parse(css).first as postcss.Rule
    expect(declOf(rule, 'color')).toBe('var(--text-primary)')
  })

  it('目标选择器被后续逗号分支规则覆盖时判重复（不按整选择器字符串相等，须唯一）', () => {
    const root = postcss.parse(
      '.pw-dialog-danger { color: var(--on-danger); }\n' +
        '.other, .pw-dialog-danger { color: var(--text-primary); }',
    )
    expect(() => ruleIn(root, 'fixture', '.pw-dialog-danger')).toThrow(/须唯一/)
  })
})

describe('background-color 消费入口（review 5277799858）', () => {
  it.each(['background-color', 'BACKGROUND-Color'])(
    '%s 的尺寸值失败，语义色与 currentcolor 保持有效',
    (prop) => {
      const root = postcss.parse(
        `.bad { ${prop}: var(--radius-sm) } .good { ${prop}: var(--text-primary) } .inherited { ${prop}: currentcolor }`,
      )
      expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
        '.bad background-color: 4px',
      ])
    },
  )
})

describe('根令牌取胜后的消费结果（review 5277799858）', () => {
  // 排列维度：单一 !important 两种源序、双 !important 与双普通取后位、
  // 保证无效（initial/悬空）触发 fallback（有效回退通过/无效回退报错）；
  // 镜像排列与同维变体已并（issue #291 精简重复用例）。
  it.each([
    ['4px !important; --fg: #fff', 'var(--fg)', '4px', false],
    ['#fff; --fg: 4px !important', 'var(--fg)', '4px', false],
    ['4px !important; --fg: #fff !important', 'var(--fg)', '#fff', true],
    ['4px; --fg: #fff', 'var(--fg)', '#fff', true],
    [
      'initial !important; --fg: #fff',
      'var(--fg, currentcolor)',
      'currentcolor',
      true,
    ],
    ['var(--missing) !important; --fg: #fff', 'var(--fg, 4px)', '4px', false],
  ])('%s → %s', (definitions, consumer, expected, valid) => {
    const root = postcss.parse(`.target { color: ${consumer} }`)
    const ctx: WiringCtx = {
      env: LIGHT_ENV,
      tokens: tokenValuesOf(
        postcss.parse(`:root { --fg: ${definitions}; }`),
        LIGHT_ENV,
      ),
      locals: localDefinitions(root),
    }
    const value = displayValueIn([...sheetDecls(root)][0]!, ctx)
    expect(value).toBe(expected)
    expect(colorTypeOk('color', value!)).toBe(valid)
  })

  it.each([
    ['light', false, '#fff'],
    ['dark', false, '4px'],
    ['light', true, '#fff'],
    ['dark', true, '#fff'],
  ] as const)(
    '%s 环境，后位 important=%s',
    (scheme, laterImportant, expected) => {
      const source = postcss.parse(
        ':root { --fg: #000; }' +
          '@media (prefers-color-scheme: dark) { :root { --fg: 4px !important; } }' +
          `:root { --fg: #fff${laterImportant ? ' !important' : ''}; }`,
      )
      const env = { ...LIGHT_ENV, scheme }
      const ctx: WiringCtx = {
        env,
        tokens: tokenValuesOf(source, env),
        locals: new Map(),
      }
      const at = [
        ...sheetDecls(postcss.parse('.target { color: var(--fg) }')),
      ][0]!
      expect(displayValueIn(at, ctx)).toBe(expected)
    },
  )
})

describe('CSS 空白与 NBSP 的关键字判定边界（issue #339）', () => {
  it('局部定义 NBSP unset：共享显示值路径交付原值，不进 fallback', () => {
    const root = postcss.parse(
      '.a { --fg: \u00a0unset; color: var(--fg, #fff); }',
    )
    const ctx: WiringCtx = {
      env: LIGHT_ENV,
      tokens: new Map(),
      locals: localDefinitions(root),
    }
    const consumer = [...sheetDecls(root)].find((d) => d.prop === 'color')!
    expect(displayValueIn(consumer, ctx)).toBe('\u00a0unset')
  })

  it('根令牌 NBSP unset：不作保证无效归一，消费点按颜色语义拒绝非法值', () => {
    // 引擎侧不得把 '\u00a0unset' 误判为 unset 关键字（否则归一 initial /
    // 悬空）；类型检查侧同样不得按 JS trim 认作 CSS-wide 关键字而放行——
    // 该值是非法颜色，须按颜色语义拒绝（issue #339）
    const root = postcss.parse(
      ':root { --s: \u00a0unset; } .a { color: var(--s); }',
    )
    expect(danglingRefs(root, LIGHT_ENV)).toEqual([])
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
      '.a color: \u00a0unset',
    ])
  })

  it.each(['background', 'outline', 'text-decoration'])(
    '简写取值 NBSP unset：切分按 CSS 空白语义保留成分，类型检查拒绝（issue #339 评审）',
    (prop) => {
      // colorTypeOk 入口裁剪已保住 NBSP，但 postcss.list 的成分裁剪用
      // JS trim：'\u00a0unset' 被折算回 'unset' 命中 NON_COLOR_KEYWORDS
      // 而放行——切分必须同用 CSS 空白语义（issue #339 评审）
      const root = postcss.parse(
        `:root { --s: \u00a0unset; } .a { ${prop}: var(--s); }`,
      )
      expect(danglingRefs(root, LIGHT_ENV)).toEqual([])
      expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
        `.a ${prop}: \u00a0unset`,
      ])
    },
  )

  it('切分保留 NBSP：成分不折算成关键字或完整颜色，普通空白对照不变', () => {
    // 简写层：'\u00a0unset' 是未知标识符成分，不得命中关键字集合
    expect(colorTypeOk('background', '\u00a0unset')).toBe(false)
    expect(colorTypeOk('outline', 'unset\u00a0')).toBe(false)
    // 颜色列表：'#fff\u00a0' 是 hash + 标识符两个 token，非完整颜色成分
    expect(colorTypeOk('border-color', '#fff\u00a0')).toBe(false)
    // 对照：普通 CSS 空白包围的关键字仍是合法属性值
    expect(colorTypeOk('background', ' unset ')).toBe(true)
  })

  it.each([
    ['background-image', '\u00a0none'],
    ['border-image-source', '\u00a0url(a.png)'],
  ])(
    '图像长形 %s 的 NBSP 不得折算成合法图像 token（issue #339 评审二轮）',
    (prop, value) => {
      // imageValueOk 自带逗号切分的入列裁剪也是 JS trim：'\u00a0none' 被
      // 折算成 'none'、'\u00a0url(...)' 被折算成完整 url() 图像——必须与
      // 其他入口同用 CSS 空白集裁剪（issue #339 评审二轮）
      expect(colorTypeOk(prop, value)).toBe(false)
    },
  )

  it('图像长形端到端：NBSP none 按非法值报错，普通空白对照不变（issue #339 评审二轮）', () => {
    const root = postcss.parse(
      ':root { --s: \u00a0none; } .a { background-image: var(--s); }',
    )
    expect(danglingRefs(root, LIGHT_ENV)).toEqual([])
    expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([
      '.a background-image: \u00a0none',
    ])
    // 对照：普通 CSS 空白包围的 none 仍是合法图像长形取值
    expect(colorTypeOk('background-image', ' none ')).toBe(true)
  })
})
