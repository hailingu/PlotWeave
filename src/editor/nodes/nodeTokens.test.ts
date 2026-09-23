/**
 * 节点颜色令牌化机器契约（issue #107）。
 *
 * 契约来源：docs/ui-design.md 原则 2「语义色令牌，不硬编码颜色」与 §2.3
 * 核心语义令牌表；src/editor/nodes/nodes.css 文件头「组件层只引用语义令牌」。
 * 断言对象是 postcss 解析的真实样式表（与 issue 验证口径一致的 PostCSS
 * 结构统计），不逐字匹配普通文本。
 *
 * Key State And Invariant Matrix（外观 × 交互态 × 对比度）：
 * | 状态/前提 | 动作/过渡 | 可观测结果 | 不变量 | 验证 |
 * | --- | --- | --- | --- | --- |
 * | 浅/深外观，节点常态 | 渲染节点家族 | 计算色 == 重构前字面量（黄金基准） | 视觉零变化（尺寸/端口/语义不变由本单不触碰 TSX 保证） | 黄金表 |
 * | 悬停/选中/open/端口可连 | 进入交互态 | 各态计算色 == 黄金基准 | 交互态色值不漂移 | 黄金表（令牌映射原交互态字面量） |
 * | 浅 ↔ 深外观切换 | 系统外观切换 | 纸面/石板家族计算色不变 | 家族材质是跨外观恒定内容层（§4.1），不回落窗口色 | 黄金表断言 light == dark |
 * | 增强对比度 more | 开启 prefers-contrast | 家族文本令牌对比度 ≥ 4.5:1，品牌底文本（含渐变内部采样）≥ 4.5:1，虚线框/徽标边 ≥ 3:1 | 设计原则 2 的对比度承诺在对比度模式下成立 | WCAG 计算（渐变沿 sRGB 插值采样） |
 * | 令牌接线 | 渲染任意节点 | nodes.css 的 var(--x) 全部可解析 | 无失效 var（静默回落初始值） | 接线测试 |
 * | 结构回归 | 新增节点样式 | nodes.css 颜色类声明零硬编码色值 | 新颜色必须经 tokens.css 进入 | 结构测试 |
 * 未覆盖维度：并发/时序不适用（静态样式表）；端口常态色对比度维持基线
 * 值不变（记录在案边界，P3，非文本内容）；角色头像字（--on-saturated）的
 * 承载面是应用指派的渐变用户内容色，无确定性对比面，不在契约内（P3，
 * PR #114 评审 4000077439 后徽标/胶囊改走确定性契约的 --on-brand）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string): string =>
  readFileSync(join(repoRoot, path), 'utf8')

const nodesCss = postcss.parse(read('src/editor/nodes/nodes.css'))
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

/** 消解一层 var() 引用（--branch-dim: var(--text-secondary) 形态）。 */
function resolveOnce(value: string, tokens: Map<string, string>): string {
  return value.replace(
    /var\(\s*(--[\w-]+)\s*\)/g,
    (whole, name: string) => tokens.get(name) ?? whole,
  )
}

describe('nodes.css 颜色结构（issue #107）', () => {
  // 不硬编码色值与 var() 接线由 sheetTokens.test.ts 的 #278 全表契约扫描
  // 所有（box-shadow 字面色按该契约 F6 边界明确不在展示色禁用范围）；
  // 本文件保留语义族归属与黄金基准。
  it('深色选中分支的填充引用画布令牌（分支族跟随画布外观契约）', () => {
    let selected: postcss.Rule | undefined
    nodesCss.walkRules((rule) => {
      const inDark =
        rule.parent?.type === 'atrule' &&
        rule.parent.name === 'media' &&
        rule.parent.params.includes('prefers-color-scheme: dark')
      if (inDark && rule.selector === '.pw-branch.pw-on') selected = rule
    })
    expect(selected, '未找到深色 .pw-branch.pw-on 规则').toBeDefined()
    const background = selected!.nodes.find(
      (node): node is postcss.Declaration =>
        node.type === 'decl' && node.prop === 'background',
    )
    // 令牌当前同值（#131316），但契约上须跟随画布：窗口/画布分化时不得漂移
    expect(background?.value).toContain('var(--surface-canvas)')
  })
})

/** 黄金基准：重构前 nodes.css 的字面量，按令牌逐一钉住（视觉零变化）。 */
const CONSTANT_TOKENS: Readonly<Record<string, string>> = {
  '--node-paper': '#fdfdf8',
  '--node-paper-note': '#f5f5f7',
  '--node-paper-text': '#1d1d1f',
  '--node-paper-text-secondary': 'rgba(60, 60, 67, 0.5)',
  '--node-paper-text-tertiary': 'rgba(60, 60, 67, 0.75)',
  '--node-paper-text-caption': 'rgba(60, 60, 67, 0.55)',
  '--node-paper-chip-text': 'rgba(60, 60, 67, 0.6)',
  '--node-paper-text-body': 'rgba(29, 29, 31, 0.85)',
  '--node-paper-gear': 'rgba(60, 60, 67, 0.45)',
  '--node-paper-gear-hover': 'rgba(60, 60, 67, 0.85)',
  '--node-paper-hover': 'rgba(0, 0, 0, 0.06)',
  '--node-paper-rule': 'rgba(90, 130, 190, 0.28)',
  '--node-paper-margin': 'rgba(224, 49, 43, 0.45)',
  '--node-paper-chip-border': 'rgba(0, 0, 0, 0.18)',
  '--node-paper-mark': 'rgba(0, 0, 0, 0.07)',
  '--node-paper-divider': 'rgba(0, 0, 0, 0.06)',
  '--node-paper-bubble': '#e9e9eb',
  '--node-paper-bubble-accent': '#dcebff',
  '--node-paper-voiceover': '#bf5af2',
  '--node-paper-voiceover-border': 'rgba(191, 90, 242, 0.4)',
  '--surface-slate': '#232326',
  '--node-slate-text': '#f5f5f7',
  '--node-slate-text-secondary': 'rgba(235, 235, 245, 0.6)',
  '--node-slate-text-soft': 'rgba(235, 235, 245, 0.75)',
  '--node-slate-text-caption': 'rgba(235, 235, 245, 0.45)',
  '--node-slate-text-muted': 'rgba(235, 235, 245, 0.65)',
  '--node-slate-text-body': 'rgba(245, 245, 247, 0.85)',
  '--node-slate-gear-hover': 'rgba(235, 235, 245, 0.92)',
  '--node-slate-hover': 'rgba(255, 255, 255, 0.1)',
  '--node-slate-inset': 'rgba(0, 0, 0, 0.35)',
  '--node-slate-well': 'rgba(0, 0, 0, 0.45)',
  '--node-slate-chip': 'rgba(255, 255, 255, 0.08)',
  '--node-slate-chip-border': 'rgba(255, 255, 255, 0.2)',
  '--node-slate-add': 'rgba(235, 235, 245, 0.3)',
  '--node-slate-error': '#ff9f9a',
  '--port-body': '#3a3a3e',
  '--port-ring': '#55555a',
  '--connection-valid': '#34c759',
  '--connection-valid-glow': 'rgba(52, 199, 89, 0.8)',
  '--on-saturated': '#ffffff',
  '--on-brand': '#ffffff',
  '--edge-label-bg': 'var(--brand-gradient)',
  '--invalid-stripe': 'rgba(142, 142, 147, 0.35)',
  '--shadow-node-paper': '0 12px 32px rgba(0, 0, 0, 0.35)',
  '--shadow-node-note': '0 12px 32px rgba(0, 0, 0, 0.4)',
  '--shadow-node-beat': '0 10px 28px rgba(0, 0, 0, 0.35)',
  '--shadow-node-slate': '0 12px 32px rgba(0, 0, 0, 0.45)',
  '--shadow-edge-label': '0 4px 12px rgba(0, 0, 0, 0.25)',
  '--shadow-controls': '0 4px 16px rgba(0, 0, 0, 0.15)',
}

/** 分支家族跟随画布外观：light/dark 各有黄金值。 */
const BRANCH_TOKENS: Readonly<Record<string, { light: string; dark: string }>> =
  {
    '--branch-bg': { light: '#ffffff', dark: 'transparent' },
    '--branch-text': { light: 'var(--text-primary)', dark: '#f5f5f7' },
    '--branch-frame': {
      light: 'rgba(0, 0, 0, 0.3)',
      dark: 'rgba(235, 235, 245, 0.35)',
    },
    '--branch-opt-bg': {
      light: 'rgba(0, 0, 0, 0.05)',
      dark: 'rgba(255, 255, 255, 0.08)',
    },
    '--branch-opt-text': {
      light: '#3a3a3c',
      dark: 'rgba(245, 245, 247, 0.92)',
    },
    '--branch-addopt-border': {
      light: 'rgba(0, 0, 0, 0.22)',
      dark: 'rgba(235, 235, 245, 0.3)',
    },
    '--branch-dim': {
      light: 'var(--text-secondary)',
      dark: 'rgba(235, 235, 245, 0.45)',
    },
  }

describe('节点材质令牌黄金基准（视觉零变化 + 家族恒定）', () => {
  const light = tokenValues({
    scheme: 'light',
    contrast: 'no-preference',
    transparency: 'no-preference',
    motion: 'no-reduce',
  })
  const dark = tokenValues({
    scheme: 'dark',
    contrast: 'no-preference',
    transparency: 'no-preference',
    motion: 'no-reduce',
  })

  it('纸面/石板/端口令牌取值等于重构前字面量，且双外观恒定', () => {
    for (const [name, expected] of Object.entries(CONSTANT_TOKENS)) {
      expect(light.get(name), `${name} light`).toBe(expected)
      expect(dark.get(name), `${name} dark（家族恒定，不得随外观切换）`).toBe(
        expected,
      )
    }
  })

  it('分支令牌按外观取黄金值（跟随画布外观的家族）', () => {
    for (const [name, expected] of Object.entries(BRANCH_TOKENS)) {
      expect(light.get(name), `${name} light`).toBe(expected.light)
      expect(dark.get(name), `${name} dark`).toBe(expected.dark)
    }
  })
})

interface Rgb {
  r: number
  g: number
  b: number
}

/** 解析 #rgb/#rrggbb/#rrggbbaa/rgb()/rgba()；其余形式返回 null。 */
function parseColor(input: string): (Rgb & { a: number }) | null {
  const value = input.trim()
  const hex = value.match(/^#([0-9a-fA-F]{3,8})$/)
  if (hex) {
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
  return null
}

/** 前景按 alpha 合成到背景上（sRGB 空间，与 CSS 视觉一致）。 */
function blendOver(fg: Rgb & { a: number }, bg: Rgb): Rgb {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
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

/** 令牌解析为颜色（消解一层 var 链；非颜色值返回 null）。 */
function tokenColor(
  name: string,
  tokens: Map<string, string>,
): (Rgb & { a: number }) | null {
  const raw = tokens.get(name)
  if (raw === undefined) throw new Error(`令牌 ${name} 未定义`)
  return parseColor(resolveOnce(raw, tokens))
}

/** 背景令牌可能带透明（分支深色 = transparent），合成到承载面上。 */
function effectiveBg(
  bgName: string,
  surfaceName: string,
  tokens: Map<string, string>,
): Rgb {
  const bg = tokenColor(bgName, tokens)
  const surface = tokenColor(surfaceName, tokens)
  if (!bg || !surface) throw new Error('背景/承载面令牌非颜色值')
  return bg.a >= 1 ? bg : blendOver(bg, surface)
}

/** 迭代消解 var() 引用链至无引用（深度限 12，防循环）。 */
function resolveChain(value: string, tokens: Map<string, string>): string {
  let current = value
  for (let i = 0; i < 12 && current.includes('var('); i += 1) {
    current = resolveOnce(current, tokens)
  }
  if (current.includes('var(')) throw new Error(`var() 链过深: ${value}`)
  return current
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
 * 解析纯色或 linear-gradient 色标并沿 sRGB 插值均匀采样。纯色返回单点；
 * 渐变按色标分段插值（浏览器默认 sRGB 插值）。角度/方向首段跳过。
 */
function gradientSamples(resolved: string, steps: number): Rgb[] {
  const value = resolved.trim()
  const colors: Rgb[] = []
  const expand = (raw: string): void => {
    if (raw.toLowerCase().startsWith('linear-gradient')) {
      const inner = raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')'))
      for (const part of splitTopLevel(inner)) {
        const trimmed = part.trim()
        if (/^(-?[\d.]+(deg|turn|rad|grad)|to\s)/i.test(trimmed)) continue
        const color = parseColor(trimmed)
        if (!color) throw new Error(`无法解析渐变色标: ${trimmed}`)
        colors.push(color)
      }
      return
    }
    const color = parseColor(raw)
    if (!color) throw new Error(`无法解析背景色: ${raw}`)
    colors.push(color)
  }
  expand(value)
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

/** more 对比度环境（浅/深双外观）：石板族家族恒定，浅外观下同样渲染深色
 * 石板，石板断言必须覆盖两种外观（PR #114 评审 3999996133）。 */
const LIGHT_MORE: Env = {
  scheme: 'light',
  contrast: 'more',
  transparency: 'no-preference',
  motion: 'no-reduce',
}
const DARK_MORE: Env = {
  scheme: 'dark',
  contrast: 'more',
  transparency: 'no-preference',
  motion: 'no-reduce',
}
const lightMore = tokenValues(LIGHT_MORE)
const darkMore = tokenValues(DARK_MORE)

/** 纸面/分支文本目标：令牌 × 承载背景令牌（在同一表面族上）。 */
const PAPER_TEXT_TARGETS: Readonly<{ token: string; on: string }[]> = [
  { token: '--node-paper-text', on: '--node-paper' },
  { token: '--node-paper-text-secondary', on: '--node-paper' },
  { token: '--node-paper-text-tertiary', on: '--node-paper' },
  { token: '--node-paper-text-caption', on: '--node-paper-note' },
  { token: '--node-paper-chip-text', on: '--node-paper' },
  { token: '--node-paper-text-body', on: '--node-paper' },
  { token: '--node-paper-gear', on: '--node-paper' },
  { token: '--node-paper-gear-hover', on: '--node-paper-note' },
  { token: '--node-paper-voiceover', on: '--node-paper-note' },
  { token: '--branch-opt-text', on: '--branch-opt-bg' },
]

/** 石板族文本目标：家族恒定，浅/深外观共用同一承载面与取值。 */
const SLATE_TEXT_TARGETS: Readonly<string[]> = [
  '--node-slate-text',
  '--node-slate-text-secondary',
  '--node-slate-text-soft',
  '--node-slate-text-caption',
  '--node-slate-text-muted',
  '--node-slate-text-body',
  '--node-slate-gear-hover',
  '--node-slate-error',
]

/** 断言令牌文本在承载背景上达到目标对比度：半透明前景先按 alpha 合成到
 * 背景（渲染色），再算 WCAG 对比度——直接对未合成色算会系统性偏高漏检
 * （PR #114 评审 3999996133 复盘：浅外观石板 caption 漏检即此因）。 */
function expectContrast(
  token: string,
  bgName: string,
  surfaceName: string,
  tokens: Map<string, string>,
  min: number,
): void {
  const fg = tokenColor(token, tokens)
  const bg = effectiveBg(bgName, surfaceName, tokens)
  if (!fg) throw new Error(`令牌 ${token} 非颜色值`)
  const rendered = fg.a >= 1 ? fg : blendOver(fg, bg)
  expect(
    contrastRatio(rendered, bg),
    `${token} on ${bgName} = ${contrastRatio(rendered, bg).toFixed(2)}:1`,
  ).toBeGreaterThanOrEqual(min)
}

describe('增强对比度：家族文本 ≥ 4.5:1（§2 原则 2）', () => {
  it('纸面/分支文本令牌在 more 对比度下达标', () => {
    for (const { token, on } of PAPER_TEXT_TARGETS) {
      const surface = on === '--branch-opt-bg' ? '--branch-bg' : on
      expectContrast(token, on, surface, lightMore, 4.5)
    }
    // branch-dim 是 var 链，消解后同样须达标（浅外观 = text-secondary more 变体）
    expectContrast('--branch-dim', '--branch-bg', '--branch-bg', lightMore, 4.5)
    // 分支族跟随画布外观：深外观下 dim/opt-text 同样须达标。分支深色底为
    // transparent，addopt 文字实际画在画布底色上（PR #114 评审 4000027706）
    expectContrast(
      '--branch-dim',
      '--surface-canvas',
      '--surface-canvas',
      darkMore,
      4.5,
    )
    expectContrast(
      '--branch-opt-text',
      '--branch-opt-bg',
      '--surface-canvas',
      darkMore,
      4.5,
    )
  })

  it('石板文本令牌在 more 对比度下达标（浅/深外观，家族恒定）', () => {
    for (const tokens of [lightMore, darkMore]) {
      for (const token of SLATE_TEXT_TARGETS) {
        expectContrast(token, '--surface-slate', '--surface-slate', tokens, 4.5)
      }
    }
  })

  it('品牌底文本（连线胶囊/✓ 徽标）在 more 对比度下达标（浅/深外观）', () => {
    // 胶囊底 = 品牌渐变 var(--accent-alt) → var(--accent)（more 下经
    // --edge-label-bg 收敛为实色 accent）；徽标底 = 纯色 accent-alt。
    // 注意：sRGB 伽马曲线的凸性使亮度沿插值非单调，两端达标不代表内部
    // 达标——渐变内部由下方 .pw-edge-label 采样用例覆盖（PR #114 评审
    // 4000077439 / 4000104125）。
    for (const tokens of [lightMore, darkMore]) {
      expectContrast('--on-brand', '--accent-alt', '--accent-alt', tokens, 4.5)
      expectContrast('--on-brand', '--accent', '--accent', tokens, 4.5)
    }
  })

  it('连线胶囊背景全程（含渐变内部）与 on-brand ≥ 4.5:1（浅/深）', () => {
    // 直接对 nodes.css 中 .pw-edge-label 的实际 background 声明沿渐变
    // sRGB 插值采样 9 点断言（评审 4000104125：仅验两端会漏掉中段
    // 3.69–4.08:1 的凹陷；more 下胶囊底经 --edge-label-bg 近实色化）。
    let label: postcss.Rule | undefined
    nodesCss.walkRules((rule) => {
      if (rule.selector === '.pw-edge-label') label = rule
    })
    expect(label, '未找到 .pw-edge-label 规则').toBeDefined()
    const background = label!.nodes.find(
      (node): node is postcss.Declaration =>
        node.type === 'decl' && node.prop === 'background',
    )
    expect(background, '未找到 background 声明').toBeDefined()
    for (const [name, tokens] of [
      ['light', lightMore],
      ['dark', darkMore],
    ] as const) {
      const fg = tokenColor('--on-brand', tokens)!
      for (const [i, bg] of gradientSamples(
        resolveChain(background!.value, tokens),
        9,
      ).entries()) {
        expect(
          contrastRatio(fg, bg),
          `${name} 背景采样 ${i} = ${contrastRatio(fg, bg).toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

describe('增强对比度：UI 组件 ≥ 3:1（非文本）', () => {
  it('分支虚线框/添加行边、画外音徽标边在 more 对比度下达标', () => {
    const uiTargetsLight = [
      { token: '--branch-frame', bg: '--branch-bg', surface: '--branch-bg' },
      {
        token: '--branch-addopt-border',
        bg: '--branch-bg',
        surface: '--branch-bg',
      },
      {
        token: '--node-paper-voiceover-border',
        bg: '--node-paper-note',
        surface: '--node-paper-note',
      },
    ]
    for (const { token, bg, surface } of uiTargetsLight) {
      expectContrast(token, bg, surface, lightMore, 3)
    }
    // 深色下分支底透明，虚线框实际画在画布底色上
    for (const token of ['--branch-frame', '--branch-addopt-border']) {
      expectContrast(token, '--surface-canvas', '--surface-canvas', darkMore, 3)
    }
  })
})
