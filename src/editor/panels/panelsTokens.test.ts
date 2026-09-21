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
 * | danger 确认/删除悬停 | :hover / danger 挂类 | 前景经 --on-danger 恒定白 | 危险动作前景与其底色（--danger）成对经令牌进入 | 黄金表 |
 * | 浅 ↔ 深 ↔ more 切换 | 系统偏好切换 | 三处前景解析值 == 黄金基准 | 前景只随所属令牌变，不残留硬编码 | 黄金表（4 环境） |
 * | 令牌接线 | 渲染任意面板 | 三条规则引用的 var() 全部可解析 | 无失效 var（静默回落） | 接线测试 |
 * | 结构回归 | 新增面板样式 | color 声明零硬编码色值 | 新前景必须经 tokens.css 进入 | 结构测试 |
 * | 遮罩非回退 | 任意环境 | mask 渐隐语义保持：首末色标全透明、内部全不透明 | 遮罩行为不变（issue #240 验收），断言与色值书写形式/声明对无关 | 语义断言（alpha 剖析） |
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

/** 提取色标中的颜色部分：函数形式（含空格语法的 rgb(0 0 0)）取到配对
 * 右括号，其余取首个空白分隔词；色标的位置偏移属布局数值，不参与断言。 */
function colorTokenOf(part: string): string {
  if (!/^[\w-]+\(/.test(part)) return part.split(/\s+/)[0]!
  let depth = 0
  for (let i = 0; i < part.length; i += 1) {
    if (part[i] === '(') depth += 1
    else if (part[i] === ')') {
      depth -= 1
      if (depth === 0) return part.slice(0, i + 1)
    }
  }
  throw new Error(`色标函数未闭合: ${part}`)
}

/**
 * 遮罩色标 alpha 剖析：渐隐遮罩渲染只消费 alpha 通道，与色相书写形式
 * 无关（#000 / black / rgb(0 0 0) / rgb(0,0,0) 等价）。建模 hex /
 * rgb() / rgba()（逗号与空格语法）/ 具名色（CSS 具名色除 transparent 外
 * 均不透明）；其余形式（var()、color-mix() 等）抛错——超出本契约的改法
 * 须同步更新用例而非静默通过（PR #256 评审 4063923436）。
 */
function stopAlpha(token: string): number {
  const value = token.trim()
  const percent = (raw: string): number =>
    raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw)
  if (/^transparent$/i.test(value)) return 0
  const hex = value.match(/^#([0-9a-fA-F]{3,8})$/)
  if (hex) {
    let digits = hex[1]!
    if (digits.length === 3 || digits.length === 4) {
      digits = [...digits].map((ch) => ch + ch).join('')
    }
    if (digits.length === 6) return 1
    if (digits.length === 8) return parseInt(digits.slice(6, 8), 16) / 255
    throw new Error(`未建模的 hex 形式: ${value}`)
  }
  const comma = value.match(
    /^rgba?\(\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*(?:,\s*([\d.]+%?)\s*)?\)$/,
  )
  if (comma) return comma[4] === undefined ? 1 : percent(comma[4])
  const space = value.match(
    /^rgba?\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+%?)(?:\s*\/\s*([\d.%]+))?\)$/,
  )
  if (space) return space[4] === undefined ? 1 : percent(space[4])
  if (/^[\w-]+$/.test(value)) return 1
  throw new Error(`未建模的遮罩色标形式: ${value}`)
}

/** linear-gradient 遮罩的色标 alpha 序列（方向段跳过）。 */
function maskStopAlphas(value: string): number[] {
  const inner = value
    .trim()
    .slice(value.indexOf('(') + 1, value.lastIndexOf(')'))
  return splitTopLevel(inner)
    .map((part) => part.trim())
    .filter((part) => !/^(-?[\d.]+(deg|turn|rad|grad)|to\s)/i.test(part))
    .map((part) => stopAlpha(colorTokenOf(part)))
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

/** issue #240 三处前景所在规则 → 各自的前景/背景声明。 */
const TARGETS: Readonly<{ selector: string; fg: string; bg: string }[]> = [
  { selector: '.pw-outline-ep-btn.on', fg: 'color', bg: 'background' },
  { selector: '.pw-ai-btn.primary.danger', fg: 'color', bg: 'background' },
  { selector: '.pw-settings-x:hover', fg: 'color', bg: 'background' },
]

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

describe('panels.css 前景色结构（issue #240）', () => {
  it('文本前景 color 声明不硬编码色值，全部经语义令牌', () => {
    const literal =
      /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bhwb\(|\blab\(|\blch\(|\boklab\(|\boklch\(|\bcolor\(/
    const offenders: string[] = []
    panelsCss.walkDecls((decl) => {
      if (decl.prop === 'color' && literal.test(decl.value)) {
        offenders.push(`${decl.prop}: ${decl.value}`)
      }
    })
    expect(offenders).toEqual([])
  })

  it('面板滚动遮罩语义：上下边缘全透明、中段全不透明（与色值书写形式无关）', () => {
    // 渐隐遮罩渲染只消费 alpha：断言首末色标全透明、内部色标全不透明这一
    // 可观测语义；#000/black/rgb(0 0 0) 等书写等价不误报，声明条数与
    // 前缀形态（一条或多条、标准或 -webkit-）不钉（评审 4063923436）
    let scroll: postcss.Rule | undefined
    panelsCss.walkRules((rule) => {
      if (rule.selector === '.pw-panel-scroll') scroll = rule
    })
    expect(scroll, '未找到 .pw-panel-scroll 规则').toBeDefined()
    const masks = (scroll!.nodes ?? []).filter(
      (node): node is postcss.Declaration =>
        node.type === 'decl' && node.prop.endsWith('mask-image'),
    )
    expect(masks.length, '至少一条 mask-image 声明承载渐隐').toBeGreaterThan(0)
    for (const decl of masks) {
      if (!/^linear-gradient\(/i.test(decl.value.trim())) {
        throw new Error(`${decl.prop} 非 linear-gradient 形式，未建模`)
      }
      const alphas = maskStopAlphas(decl.value)
      expect(alphas.length, `${decl.prop} 色标数`).toBeGreaterThanOrEqual(3)
      expect(alphas[0], `${decl.prop} 顶边全透明`).toBe(0)
      expect(alphas[alphas.length - 1], `${decl.prop} 底边全透明`).toBe(0)
      for (const [i, alpha] of alphas.slice(1, -1).entries()) {
        expect(alpha, `${decl.prop} 内部色标 ${i} 须全不透明`).toBe(1)
      }
    }
  })
})

describe('三处前景的语义接线与黄金基准（issue #240）', () => {
  it('三条规则的前景/背景声明均经 var() 令牌引用，不残留字面量', () => {
    for (const { selector, fg, bg } of TARGETS) {
      const rule = ruleOf(selector)
      expect(declOf(rule, fg), `${selector} ${fg}`).toMatch(/^var\(--[\w-]+\)$/)
      expect(declOf(rule, bg), `${selector} ${bg}`).toMatch(/^var\(--[\w-]+\)$/)
    }
  })

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

  it('危险动作前景经 --on-danger：四环境恒定 #ffffff（视觉零变化）', () => {
    for (const { selector } of TARGETS.slice(1)) {
      const rule = ruleOf(selector)
      expect(declOf(rule, 'background')).toBe('var(--danger)')
      for (const [name, env] of [...BASELINE_ENVS, ...MORE_ENVS]) {
        expect(
          resolveChain(declOf(rule, 'color'), tokenValues(env)),
          `${selector} ${name}`,
        ).toBe('#ffffff')
      }
    }
  })
})

describe('令牌接线（issue #240）', () => {
  it('三条规则引用的 var() 全部在 tokens.css 有定义（无悬空回落）', () => {
    const defined = new Set<string>()
    tokensCss.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) defined.add(decl.prop)
    })
    for (const { selector } of TARGETS) {
      for (const match of ruleOf(selector)
        .toString()
        .matchAll(/var\(\s*(--[\w-]+)/g)) {
        expect(defined.has(match[1]!), `${selector} 引用 ${match[1]}`).toBe(
          true,
        )
      }
    }
  })
})
