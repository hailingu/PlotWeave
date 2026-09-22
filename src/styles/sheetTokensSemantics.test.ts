/**
 * sheetTokens 契约的语义/夹具单元测试（issue #278）：CSS 层叠/取值引擎
 * （`sheetTokensEngine.ts`）的行为断言，使用合成 postcss 夹具而非真实
 * 组件样式表——与 `sheetTokens.test.ts`（真实样式表扫描：发现/结构/接线/
 * 配对/黄金接线/遮罩）拆分，避免单文件超出测试文件行数上限（AGENTS.md）。
 * 两文件共享同一引擎实现，逻辑不分叉；纯值校验（字面色探测、颜色成分/
 * 文法）由 `cssColorContract.ts` 负责。
 *
 * Key State And Invariant Matrix（本文件覆盖的引擎语义；真实样式表扫描
 * 矩阵行见 sheetTokens.test.ts 头注）：
 * | 状态/前提 | 动作/过渡 | 可观测结果 | 不变量 | 验证 |
 * | --- | --- | --- | --- | --- |
 * | 展示色属性名为非标准大小写（如 `Color`） | 分类前归一 | 仍按标准属性分类，字面色不因大小写绕过 | 标准属性名 ASCII 大小写不敏感 | 分类与集成语义用例 |
 * | background-color 长形使用尺寸或语义色 | 归一后进入类型扫描 | 尺寸失败，语义色与 currentcolor 通过 | 背景长形与其他展示色使用同一分类入口 | background-color 消费用例 |
 * | 主变量有效而备用路径悬空，或主值按环境/分支失效 | 接线仅遍历被选中的路径 | 未选备用路径通过，选中的缺失名被点名 | 接线与类型扫描使用相同作用域和取值规则 | 接线实际取值路径测试 |
 * | 缺失/initial/断链/循环变量带 fallback，或有效主值带无效 fallback | 解析实际生效值（含嵌套回退） | 无效值及独立空值报错，有效主值/回退通过 | fallback 不绕过消费属性类型校验，主值有效时不消费回退 | fallback 取值测试 |
 * | 纯颜色值含颜色与多余尺寸/数值/词形，或边框/阴影合法含多个成分 | 校验完整顶层颜色值并区分属性类别 | 纯颜色混合值报错，合法简写/列表通过 | 一个颜色成分不能使整条无效纯颜色值通过 | 完整纯颜色值测试 |
 * | 逗号选择器各分支的局部同名定义不同，或仅部分环境活跃 | 逐分支、逐环境解析遮蔽值 | 仅无效分支报错，无局部定义的分支取根令牌 | 各分支只消费自身可达活跃的定义 | 分支取值测试 |
 * | 同选择器同条件内多条局部定义含 !important | 局部取胜扫描 | 重要声明优先于普通声明，无论源序 | 局部自定义属性也遵循重要性优先级 | 接线与类型集成语义用例 |
 * | 根令牌（tokens.css :root）同名声明含 !important，跨基线与媒体条件 | 令牌取值再消费 | 活跃重要声明优先，同重要性取后位，无效颜色被拒绝 | 根令牌与局部自定义属性同一重要性规则，非活跃声明不参与 | 令牌取值及消费正反用例 |
 * | 重要根值为 initial 或断链，消费点有 fallback | 选胜值失效后递归回退 | 有效回退恢复，无效颜色报错 | 重要性不绕过既有失败/恢复规则 | 根值 fallback 消费用例 |
 * | 自身与祖先同名定义共存，含媒体/逗号分支及失效值 | 先选最近定义元素再比较重要性 | 自身指定值不被祖先重要值覆盖；失效时按消费点回退 | 继承层级先于同元素级联，接线与类型共享选择 | 指定/继承、环境与恢复用例 |
 * | 根令牌置于非 media at-rule 或根规则内部内嵌 at-rule | 根上下文预检 | 显式拒绝未知上下文/布局，不默默返回旧值 | 根定义入口必须完整建模或明确失败 | TOKEN_ROOT_AT_RULE_UNMODELED 正反用例 |
 * | 基线定义、媒体块定义、后续基线定义三者同名依次出现 | 取胜排序 | 按真实源序选中最后一条，不因 Map 键插入位置误判 | 同名定义的胜出位置按真实源序，非分组首次插入位置 | 接线集成语义用例 |
 * | 媒体块内 !important 定义与无条件后位普通定义跨活跃条件分组共存 | 跨分组取胜 | 重要声明仍胜出，不因其条件分组位置在无条件后位定义之前而被覆盖 | 接线与类型集成语义用例 |
 * | 引用仅在无关选择器下定义的局部 var() | 接线扫描（作用域可达性） | 失败点名 | 局部定义只对自身/后代规则生效 | 接线测试 |
 * | 逗号选择器的任一引用分支无可达定义 | 接线扫描（逐分支可达） | 失败点名 | 每一分支运行时均须取得有效计算色 | 接线测试 |
 * | 同选择器同条件的后位定义为保证无效值 | 接线扫描（层叠取后位） | 失败点名 | 生效定义按源序后位判定，先位有效定义不遮蔽 | 接线测试 |
 * | 可达局部定义与根令牌同名且保证无效 | 接线扫描（局部遮蔽优先） | 失败点名 | 遮蔽分支按局部值判定，根令牌不救 | 接线测试 |
 * | 引用点在某环境活跃而定义仅在其他环境成立（如仅浅色媒体块内定义） | 接线扫描（全部支持环境逐一） | 失败点名该环境 | 定义须覆盖引用活跃的每个环境 | 接线测试 |
 * | 黄金规则内声明属性名非标准大小写 / 目标选择器出现在他规则逗号分支内 | 黄金取值与唯一性判定 | 仍按同一属性取胜值；判重复并报错 | 黄金接线与通用扫描同一属性名/覆盖判定口径 | 黄金语义用例 |
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
    // 错误码契约：docs/reviews/pr-288-review-5280077466.md 的状态矩阵。
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
    // 错误码契约：docs/reviews/pr-288-review-5279748560.md 的根上下文矩阵。
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
  it.each([
    ['4px !important; --fg: #fff', 'var(--fg)', '4px', false],
    ['#fff; --fg: 4px !important', 'var(--fg)', '4px', false],
    ['4px !important; --fg: #fff !important', 'var(--fg)', '#fff', true],
    ['#fff !important; --fg: 4px !important', 'var(--fg)', '4px', false],
    ['4px; --fg: #fff', 'var(--fg)', '#fff', true],
    ['#fff; --fg: 4px', 'var(--fg)', '4px', false],
    ['#fff !important; --fg: 4px', 'var(--fg)', '#fff', true],
    [
      'initial !important; --fg: #fff',
      'var(--fg, currentcolor)',
      'currentcolor',
      true,
    ],
    ['initial !important; --fg: #fff', 'var(--fg, 4px)', '4px', false],
    [
      'var(--missing) !important; --fg: #fff',
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
