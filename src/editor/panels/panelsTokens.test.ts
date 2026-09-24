/**
 * 面板前景色令牌化机器契约（issue #240）。
 *
 * 契约来源：docs/ui-design.md 原则 2「语义色令牌，不硬编码颜色」与 §2.3
 * 核心语义令牌表；src/styles/tokens.css 文件头「组件只引用此处的语义变量」。
 * 断言对象是 postcss 解析的真实样式表（与 issue #107 的 nodeTokens.test.ts
 * 同一验证口径），不逐字匹配普通文本。
 *
 * 范围界定（issue #240 验收标准）：
 * - 三处展示前景色（大纲集选中、AI 批次删除确认、设定集条目删除悬停）由
 *   语义令牌决定：品牌底复用 --on-brand，danger 底走 --on-danger。
 * - 遮罩行为不变：.pw-panel-scroll 的渐隐遮罩是透明度遮罩，渲染只消费
 *   alpha 通道——止点用色属实现色而非展示主题色（issue #240 明示不为其
 *   造令牌），语义断言只校验「边缘全透明、中段全不透明」，不钉色值书写
 *   形式与声明对（PR #256 评审 4063923436）。
 * - 节点样式 #107 保证不回退：本文件不触碰 nodes.css，nodeTokens.test.ts
 *   全量用例继续通过即为其回归防线。
 *
 * Key State And Invariant Matrix（外观 × 交互态 × 对比度）：
 * | 状态/前提 | 动作/过渡 | 可观测结果 | 不变量 | 验证 |
 * | --- | --- | --- | --- | --- |
 * | 浅/深外观，常态 | 渲染三处前景 | 计算色 == 重构前字面量 #fff（视觉零变化） | 令牌化不改基线观感 | 黄金表 |
 * | 大纲集进入选中态 | .on 挂类 | 前景经 --on-brand：基线白、more 翻黑；底经 --edge-label-bg | 品牌底前景全应用同一令牌行为（tokens.css 既有契约） | 黄金表 |
 * | 大纲集选中态 × more | 系统开增强对比度 | 前景/背景配对全程 ≥ 4.5:1（底随 --edge-label-bg 近实色收敛） | on-brand 的 ≥4.5 承诺依赖 edge.label.bg 配对（PR #256 评审 4063743839） | 配对采样断言 |
 * | danger 确认/删除悬停 | :hover / danger 挂类 | 前景经 --on-danger 恒定白 | 危险动作前景与其底色（--danger）成对经令牌进入 | sheetTokens.test.ts 的 DANGER_RULES 黄金表（issue #291 并入） |
 * | 浅 ↔ 深 ↔ more 切换 | 系统偏好切换 | 三处前景解析值 == 黄金基准 | 前景只随所属令牌变，不残留硬编码 | 黄金表（4 环境） |
 * | 令牌接线 | 渲染任意面板 | 三条规则引用的 var() 全部可解析 | 无失效 var（静默回落） | #278 全表接线扫描（sheetTokens.test.ts） |
 * | 结构回归 | 新增面板样式 | color 声明零硬编码色值 | 新前景必须经 tokens.css 进入 | #278 全表结构扫描（sheetTokens.test.ts） |
 * | 遮罩非回退 | 任意环境 | mask 渐隐语义保持：首末色标全透明、内部全不透明 | 遮罩行为不变（issue #240 验收），断言与色值书写形式/声明对无关 | #278 全表遮罩语义扫描（sheetTokens.test.ts） |
 *
 * 未覆盖维度：并发/时序不适用（静态样式表）；--on-danger 白字在深色外观
 * danger 底（#ff6961）上的对比度约 2.8:1，与重构前逐位相同——按 issue #240
 * 口径「本次未实测它们的对比度，不宣称已违反特定对比度比例」作为已知边界
 * 记录（tokens.css 令牌注释与本测试黄金值共同钉住现状， remediation 归
 * 后续单）。已知边界：panels.css 其余 var() 接线（如 .pw-ai-cancel:hover 的
 * --fill-tertiary 悬空引用）是本单之前既有的独立缺陷，接线测试只覆盖
 * 本单引入的三条规则，避免越权扩大契约。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string): string =>
  readFileSync(join(repoRoot, path), 'utf8')

const panelsCss = postcss.parse(read('src/editor/panels/panels.css'))
const tokensCss = postcss.parse(read('src/styles/tokens.css'))

type Env = {
  scheme: 'light' | 'dark'
  contrast: 'no-preference' | 'more'
  transparency: 'no-preference' | 'reduce'
  motion: 'no-reduce' | 'reduce'
}

const MEDIA_FEATURES = {
  'prefers-color-scheme': 'scheme',
  'prefers-contrast': 'contrast',
  'prefers-reduced-transparency': 'transparency',
  'prefers-reduced-motion': 'motion',
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

/** 迭代消解 var() 引用链至无引用（深度限 12，防循环）。 */
function resolveChain(value: string, tokens: Map<string, string>): string {
  let current = value
  for (let i = 0; i < 12 && current.includes('var('); i += 1) {
    current = current.replace(/var\(\s*(--[\w-]+)\s*\)/g, (whole, name) => {
      const resolved = tokens.get(name as string)
      return resolved === undefined ? whole : resolved
    })
  }
  if (current.includes('var(')) throw new Error(`var() 链过深或悬空: ${value}`)
  return current
}

/** 按选择器找 panels.css 顶层规则（本文件目标规则均在顶层）。 */
function ruleOf(selector: string): postcss.Rule {
  let found: postcss.Rule | undefined
  panelsCss.walkRules((rule) => {
    if (rule.selector === selector) found = rule
  })
  if (!found) throw new Error(`未找到规则 ${selector}`)
  return found
}

interface Rgb {
  r: number
  g: number
  b: number
}

/** 解析 #rgb/#rrggbb/#rrggbbaa；其余形式返回 null。 */
function parseColor(input: string): (Rgb & { a: number }) | null {
  const hex = input.trim().match(/^#([0-9a-fA-F]{3,8})$/)
  if (!hex) return null
  let digits = hex[1]!
  if (digits.length === 3 || digits.length === 4) {
    digits = [...digits].map((ch) => ch + ch).join('')
  }
  if (digits.length !== 6 && digits.length !== 8) return null
  return {
    r: parseInt(digits.slice(0, 2), 16),
    g: parseInt(digits.slice(2, 4), 16),
    b: parseInt(digits.slice(4, 6), 16),
    a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
  }
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

/** 顶层逗号分割（忽略括号内逗号），用于展开渐变参数列表。 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

/**
 * 解析纯色或 linear-gradient 色标并沿 sRGB 插值采样（与 nodeTokens.test.ts
 * 同口径）：纯色返回单点；渐变按色标分段插值采样 9 点——两端达标不代表
 * 内部达标（sRGB 伽马凸性，见 tokens.css --edge-label-bg 注释）。
 */
function backgroundSamples(resolved: string, steps = 9): Rgb[] {
  const value = resolved.trim()
  const colors: Rgb[] = []
  if (value.toLowerCase().startsWith('linear-gradient')) {
    const inner = value.slice(value.indexOf('(') + 1, value.lastIndexOf(')'))
    for (const part of splitTopLevel(inner)) {
      const trimmed = part.trim()
      if (/^(-?[\d.]+(deg|turn|rad|grad)|to\s)/i.test(trimmed)) continue
      const color = parseColor(trimmed)
      if (!color) throw new Error(`无法解析渐变色标: ${trimmed}`)
      colors.push(color)
    }
  } else {
    const single = parseColor(value)
    if (!single) throw new Error(`无法解析背景色: ${value}`)
    colors.push(single)
  }
  if (colors.length <= 1) return colors
  const samples: Rgb[] = []
  for (let i = 0; i < steps; i += 1) {
    const t = (i / (steps - 1)) * (colors.length - 1)
    const seg = Math.min(Math.floor(t), colors.length - 2)
    const local = t - seg
    const a = colors[seg]!
    const b = colors[seg + 1]!
    samples.push({
      r: a.r + (b.r - a.r) * local,
      g: a.g + (b.g - a.g) * local,
      b: a.b + (b.b - a.b) * local,
    })
  }
  return samples
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

const BASELINE_ENVS: Readonly<[string, Env][]> = [
  [
    'light',
    {
      scheme: 'light',
      contrast: 'no-preference',
      transparency: 'no-preference',
      motion: 'no-reduce',
    },
  ],
  [
    'dark',
    {
      scheme: 'dark',
      contrast: 'no-preference',
      transparency: 'no-preference',
      motion: 'no-reduce',
    },
  ],
]

const MORE_ENVS: Readonly<[string, Env][]> = [
  [
    'light',
    {
      scheme: 'light',
      contrast: 'more',
      transparency: 'no-preference',
      motion: 'no-reduce',
    },
  ],
  [
    'dark',
    {
      scheme: 'dark',
      contrast: 'more',
      transparency: 'no-preference',
      motion: 'no-reduce',
    },
  ],
]

// 结构（不硬编码色值）、遮罩渐隐语义与 var() 接线由 sheetTokens.test.ts
// 的 #278 全表契约扫描所有；danger 前景接线并入其 DANGER_RULES 黄金表
// （issue #291 分层收拢）。本文件保留品牌选中态的黄金基准与配对采样。

describe('三处前景的语义接线与黄金基准（issue #240）', () => {
  it('品牌选中态前景经 --on-brand、底经 --edge-label-bg：基线双外观 #ffffff（视觉零变化），more 翻黑', () => {
    const rule = ruleOf('.pw-outline-ep-btn.on')
    // 底必须经会随 more 近实色收敛的胶囊底令牌，不得直挂渐变（PR #256
    // 评审 4063743839：黑字对未收敛渐变内部最低 3.69:1，违背 ≥4.5 契约）
    expect(declOf(rule, 'background')).toBe('var(--edge-label-bg)')
    for (const [name, env] of BASELINE_ENVS) {
      expect(
        resolveChain(declOf(rule, 'color'), tokenValues(env)),
        `${name} 基线`,
      ).toBe('#ffffff')
    }
    for (const [name, env] of MORE_ENVS) {
      expect(
        resolveChain(declOf(rule, 'color'), tokenValues(env)),
        `${name} more（on-brand 既有契约：more 翻黑）`,
      ).toBe('#000000')
    }
  })

  it('more 对比度下选中胶囊前景/背景配对全程（含渐变内部采样）≥ 4.5:1（浅/深）', () => {
    const rule = ruleOf('.pw-outline-ep-btn.on')
    for (const [name, env] of MORE_ENVS) {
      const tokens = tokenValues(env)
      const fg = parseColor(resolveChain(declOf(rule, 'color'), tokens))
      if (!fg) throw new Error('前景非颜色值')
      const samples = backgroundSamples(
        resolveChain(declOf(rule, 'background'), tokens),
      )
      expect(samples.length, `${name} 背景采样点数`).toBeGreaterThan(0)
      for (const [i, bg] of samples.entries()) {
        expect(
          contrastRatio(fg, bg),
          `${name} 背景采样 ${i} = ${contrastRatio(fg, bg).toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

describe('AI 取消按钮悬停背景（issue #265：悬空 --fill-tertiary 修复）', () => {
  // 基线双外观即可覆盖：--fill-tertiary 在 tokens.css 随外观成对定义，
  // more/reduce 由接线扫描（sheetTokens.test.ts）全环境验证。
  it('悬停背景经 --fill-tertiary 定义且四环境可解析，较常态填充更实（视觉反馈加深）', () => {
    const rule = ruleOf('.pw-ai-cancel')
    const hover = ruleOf('.pw-ai-cancel:hover')
    expect(declOf(hover, 'background')).toBe('var(--fill-tertiary)')
    for (const [name, env] of BASELINE_ENVS) {
      const tokens = tokenValues(env)
      const hoverFill = resolveChain(declOf(hover, 'background'), tokens)
      expect(hoverFill, `${name} 悬停背景应解析为有效颜色`).toMatch(/^rgba?\(/)
      const restFill = resolveChain(declOf(rule, 'background'), tokens)
      // 更实的填充：alpha 通道严格大于常态（交互反馈语义，issue #265）
      const alphaOf = (v: string): number =>
        Number(v.match(/,\s*([\d.]+)\)$/)?.[1] ?? 1)
      expect(alphaOf(hoverFill), `${name} 悬停应比常态更实`).toBeGreaterThan(
        alphaOf(restFill),
      )
    }
  })
})
