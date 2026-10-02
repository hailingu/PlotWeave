/**
 * 首页项目卡菜单按钮配色机器契约（issue #261）。
 *
 * 契约来源：docs/ui-design.md 原则 2「语义色令牌，不硬编码颜色；4.5:1
 * 普通文本参考由配对契约按环境持有」与 §2.6 三无障碍变体；§3.2 悬停 ⋯
 * 菜单按钮与右键同源。断言对象是 postcss 解析的真实样式表（与 issue
 * #107 nodeTokens / issue #240 panelsTokens 同一验证口径），不逐字匹配
 * 普通文本。
 *
 * 范围界定（issue #261 验收标准）：
 * - 前景/背景配对语义令牌随外观生效：背景经 --poster-menu-bg（hover 经
 *   --poster-menu-bg-hover），前景沿用 --text-primary；浅色基线值与修复前
 *   字面量逐位相同（视觉零变化），暗色由恒白底改为同外观深色面。
 * - 半透明常态面悬浮于任意明暗的海报内容之上：对比度按纯黑/纯白最劣
 *   合成断言（合成值介于两者之间的海报内容必落在包络内），不把对比度
 *   契约寄托在特定海报内容上。
 * - 覆盖 hover 与 focus-visible：hover 换背景令牌仍 ≥ 4.5:1；
 *   :focus-visible 参与可见性规则（键盘入口保留，与右键菜单同源）。
 *
 * Key State And Invariant Matrix（外观 × 交互态 × 无障碍变体 × 承载内容）：
 * | 状态/前提 | 动作/过渡 | 可观测结果 | 不变量 | 验证 |
 * | --- | --- | --- | --- | --- |
 * | 浅色外观，常态 | 卡片悬停/钮聚焦使 ⋯ 钮可见 | 前景 #1d1d1f 于 rgba(255,255,255,.82) 面 | 前景/背景配对随外观且 ≥ 4.5:1 | 黄金表 + 最劣合成 |
 * | 暗色外观，常态 | 同上 | 前景 #f2f2f7 于 rgba(38,38,44,.94) 面 + 白系描边 | 同上 | 黄金表 + 最劣合成 |
 * | 浅/深 × hover | 悬停 ⋯ 钮 | 背景换 hover 令牌（#ffffff / #3a3a40） | hover 态对比度仍 ≥ 4.5:1 | 最劣合成断言 |
 * | 键盘入口 | Tab 聚焦 ⋯ 钮 | :focus-visible 规则置 opacity 1 | 菜单同源操作与键盘入口保留 | 选择器 + opacity 断言 |
 * | more（浅/深） | 系统开增强对比度 | 背景近实色（#ffffff / #26262c）+ 描边加强 | §2.6 变体回答齐备 | 黄金表 + 实色断言 |
 * | reduce-transparency（浅/深） | 系统降低透明度 | 背景退化为实色 | 材质退化不残留半透明 | alpha 断言 |
 * | 海报内容任意明暗 | 钮悬浮于封面/织线兜底/损坏占位 | 纯黑/纯白最劣合成对比度均 ≥ 4.5:1 | 对比度不依赖海报内容 | 最劣合成断言 |
 * | 令牌接线 | 渲染首页 | 目标规则引用的 var() 全部可解析 | 无失效 var（静默回落） | 接线测试 |
 *
 * 未覆盖维度：真实 Tauri WebView 像素/屏幕阅读器实测未运行（报告披露）；
 * 织线兜底（#1a1a1e）与损坏占位（#232326）为恒深底，已被纯黑/纯白最劣
 * 合成包络覆盖。描边与投影是面的分离手段，不在文本对比度契约内。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import { resolveChain } from '../styles/sheetTokensEngine'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path: string): string =>
  readFileSync(join(repoRoot, path), 'utf8')

const homeCss = postcss.parse(read('src/home/home.css'))
const tokensCss = postcss.parse(read('src/styles/tokens.css'))

type Env = {
  scheme: 'light' | 'dark'
  contrast: 'no-preference' | 'more'
  transparency: 'no-preference' | 'reduce'
}

const MEDIA_FEATURES = {
  'prefers-color-scheme': 'scheme',
  'prefers-contrast': 'contrast',
  'prefers-reduced-transparency': 'transparency',
} as const

/** 求 @media 前置值真伪（逗号组相或、and 相与；嵌套块由调用方递归）。 */
function mediaMatches(prelude: string, env: Env): boolean {
  return prelude
    .toLowerCase()
    .split(',')
    .some((group) =>
      group.split(' and ').every((raw) => {
        const feature = raw.trim().match(/^\(([\w-]+):\s*([\w-]+)\)$/)
        const key = feature?.[1] as keyof typeof MEDIA_FEATURES | undefined
        if (!feature || !key || !(key in MEDIA_FEATURES)) {
          throw new Error(`令牌模型未建模的 media 特性: ${raw.trim()}`)
        }
        return env[MEDIA_FEATURES[key]] === feature[2]
      }),
    )
}

/** env 下 :root 自定义属性最终值（媒体块按 env 进入，后写覆盖先写）。 */
function tokenValues(env: Env): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (container: postcss.Container): void => {
    for (const node of container.nodes ?? []) {
      if (node.type === 'atrule' && node.name === 'media') {
        if (mediaMatches(node.params, env)) walk(node)
      } else if (node.type === 'rule') {
        if (node.selector === ':root') {
          for (const decl of node.nodes ?? []) {
            if (decl.type === 'decl' && decl.prop.startsWith('--')) {
              out.set(decl.prop, decl.value)
            }
          }
        } else {
          walk(node)
        }
      }
    }
  }
  walk(tokensCss)
  return out
}

/** 按完整选择器找 home.css 顶层规则（本文件目标规则均在顶层）。 */
function ruleOf(selector: string): postcss.Rule {
  let found: postcss.Rule | undefined
  homeCss.walkRules((rule) => {
    if (rule.selector === selector) found = rule
  })
  if (!found) throw new Error(`未找到规则 ${selector}`)
  return found
}

/** 选择器列表含指定复合选择器的全部规则（含逗号分组）。 */
function rulesWithSelectorPart(part: string): postcss.Rule[] {
  const found: postcss.Rule[] = []
  homeCss.walkRules((rule) => {
    if (rule.selector.split(',').some((s) => s.trim() === part))
      found.push(rule)
  })
  return found
}

/** 规则内指定声明的原值；缺失抛错（防止声明被改名后测试静默空过）。 */
function declOf(rule: postcss.Rule, prop: string): string {
  const decl = rule.nodes.find(
    (node): node is postcss.Declaration =>
      node.type === 'decl' && node.prop === prop,
  )
  if (!decl) throw new Error(`${rule.selector} 缺少 ${prop} 声明`)
  return decl.value
}

interface Rgb {
  r: number
  g: number
  b: number
}

type Paint = Rgb & { a: number }

/** 解析 #rgb/#rrggbb/#rrggbbaa 与逗号语法 rgb()/rgba()；其余形式抛错。 */
function parsePaint(input: string): Paint {
  const value = input.trim()
  const hex = value.match(/^#([0-9a-fA-F]{3,8})$/)
  if (hex) {
    let digits = hex[1]!
    if (digits.length === 3 || digits.length === 4) {
      digits = [...digits].map((ch) => ch + ch).join('')
    }
    if (digits.length !== 6 && digits.length !== 8) {
      throw new Error(`未建模的 hex 形式: ${value}`)
    }
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
    }
  }
  const fn = value.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/,
  )
  if (fn) {
    return {
      r: Number(fn[1]),
      g: Number(fn[2]),
      b: Number(fn[3]),
      a: fn[4] === undefined ? 1 : Number(fn[4]),
    }
  }
  throw new Error(`未建模的颜色形式: ${value}`)
}

/** WCAG 2.x 相对亮度与对比度（输入 0–255 sRGB）。 */
function luminance({ r, g, b }: Rgb): number {
  const channel = (v: number): number => {
    const srgb = v / 255
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrastRatio(fg: Rgb, bg: Rgb): number {
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

/** 半透明面在纯黑/纯白承载上的合成（海报内容的明暗包络两端）。 */
function compositesOverExtremes(paint: Paint): Rgb[] {
  const over = (backdrop: number): Rgb => ({
    r: paint.a * paint.r + (1 - paint.a) * backdrop,
    g: paint.a * paint.g + (1 - paint.a) * backdrop,
    b: paint.a * paint.b + (1 - paint.a) * backdrop,
  })
  return [over(0), over(255)]
}

/**
 * 断言前景在承载面上的对比度 ≥ 4.5:1：实色面直接计算；半透明面按纯黑/
 * 纯白最劣合成各算一次（任意海报内容必落在包络内，最劣端也达标即全程
 * 达标——issue #261：不能把合成值当作特定海报的固定值）。
 */
function expectReadable(fg: Rgb, bgRaw: string, label: string): void {
  const bg = parsePaint(bgRaw)
  const surfaces = bg.a >= 1 ? [bg as Rgb] : compositesOverExtremes(bg)
  for (const [i, surface] of surfaces.entries()) {
    const ratio = contrastRatio(fg, surface)
    expect(
      ratio,
      `${label} 合成面 ${i} = ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(4.5)
  }
}

const BTN = '.project-menu-btn'
const BTN_HOVER = '.project-menu-btn:hover'

/** 目标状态的取值器：常态/ hover 的前景与背景（经令牌消解）。 */
function stateColors(env: Env, state: 'rest' | 'hover') {
  const tokens = tokenValues(env)
  const rule = state === 'rest' ? ruleOf(BTN) : ruleOf(BTN_HOVER)
  return {
    fg: resolveChain(declOf(ruleOf(BTN), 'color'), tokens),
    bg: resolveChain(declOf(rule, 'background'), tokens),
  }
}

const ALL_ENVS: Readonly<[string, Env][]> = [
  [
    'light',
    {
      scheme: 'light',
      contrast: 'no-preference',
      transparency: 'no-preference',
    },
  ],
  [
    'dark',
    {
      scheme: 'dark',
      contrast: 'no-preference',
      transparency: 'no-preference',
    },
  ],
  [
    'light+more',
    { scheme: 'light', contrast: 'more', transparency: 'no-preference' },
  ],
  [
    'dark+more',
    { scheme: 'dark', contrast: 'more', transparency: 'no-preference' },
  ],
  [
    'light+reduce',
    { scheme: 'light', contrast: 'no-preference', transparency: 'reduce' },
  ],
  [
    'dark+reduce',
    { scheme: 'dark', contrast: 'no-preference', transparency: 'reduce' },
  ],
  [
    'light+more+reduce',
    { scheme: 'light', contrast: 'more', transparency: 'reduce' },
  ],
  [
    'dark+more+reduce',
    { scheme: 'dark', contrast: 'more', transparency: 'reduce' },
  ],
]

describe('菜单按钮配色结构（issue #261）', () => {
  // 结构（不硬编码色值）与 var() 接线由 sheetTokens.test.ts 的 #278 全表
  // 契约扫描所有（含例外注册表双向校验）；本文件只保留配对/焦点/黄金基准。
  it('常态描边经配对令牌进入（暗色系白描边承载悬浮面与深底海报的分离）', () => {
    expect(declOf(ruleOf(BTN), 'border')).toMatch(
      /^1px solid var\(--poster-menu-border\)$/,
    )
  })

  it(':focus-visible 参与可见性规则且置 opacity 1（键盘入口保留）', () => {
    const rules = rulesWithSelectorPart('.project-menu-btn:focus-visible')
    expect(rules.length, '含 :focus-visible 的规则').toBeGreaterThan(0)
    expect(rules.some((rule) => declOf(rule, 'opacity') === '1')).toBe(true)
  })
})

describe('菜单按钮配对令牌黄金基准（issue #261）', () => {
  it('浅色基线与修复前字面量逐位相同（视觉零变化）：前景 #1d1d1f、面 rgba(255,255,255,.82)、hover #ffffff、描边透明', () => {
    const env: Env = {
      scheme: 'light',
      contrast: 'no-preference',
      transparency: 'no-preference',
    }
    expect(stateColors(env, 'rest').fg).toBe('#1d1d1f')
    expect(stateColors(env, 'rest').bg).toBe('rgba(255, 255, 255, 0.82)')
    expect(stateColors(env, 'hover').bg).toBe('#ffffff')
    expect(
      resolveChain(declOf(ruleOf(BTN), 'border'), tokenValues(env)).trim(),
    ).toBe('1px solid transparent')
  })

  it('暗色基线：前景 #f2f2f7、面 rgba(38,38,44,.94)、hover #3a3a40、白系描边', () => {
    const env: Env = {
      scheme: 'dark',
      contrast: 'no-preference',
      transparency: 'no-preference',
    }
    expect(stateColors(env, 'rest').fg).toBe('#f2f2f7')
    expect(stateColors(env, 'rest').bg).toBe('rgba(38, 38, 44, 0.94)')
    expect(stateColors(env, 'hover').bg).toBe('#3a3a40')
    expect(
      resolveChain(declOf(ruleOf(BTN), 'border'), tokenValues(env)).trim(),
    ).toBe('1px solid rgba(255, 255, 255, 0.14)')
  })

  it('more 对比度：背景近实色（浅 #ffffff / 深 #26262c）+ 描边加强', () => {
    for (const [name, env, bgGolden, borderGolden] of [
      [
        'light+more',
        ALL_ENVS[2]![1],
        '#ffffff',
        '1px solid rgba(0, 0, 0, 0.35)',
      ],
      [
        'dark+more',
        ALL_ENVS[3]![1],
        '#26262c',
        '1px solid rgba(255, 255, 255, 0.4)',
      ],
    ] as const) {
      expect(stateColors(env, 'rest').bg, name).toBe(bgGolden)
      expect(
        resolveChain(declOf(ruleOf(BTN), 'border'), tokenValues(env)).trim(),
        name,
      ).toBe(borderGolden)
    }
  })

  it('reduce-transparency：常态面退化为实色（§2.6 材质退化，浅/深）', () => {
    for (const [name, env] of ALL_ENVS.filter(([n]) => n.endsWith('reduce'))) {
      expect(parsePaint(stateColors(env, 'rest').bg).a, name).toBe(1)
    }
  })
})

describe('菜单按钮对比度契约（issue #261）', () => {
  it('全部环境（外观 × more × reduce-transparency）常态与 hover ≥ 4.5:1（半透明按纯黑/纯白最劣合成）', () => {
    for (const [name, env] of ALL_ENVS) {
      for (const state of ['rest', 'hover'] as const) {
        const { fg, bg } = stateColors(env, state)
        expectReadable(parsePaint(fg), bg, `${name} ${state}`)
      }
    }
  })
})
