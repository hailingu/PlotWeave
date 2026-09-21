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
 * - 遮罩行为不变：.pw-panel-scroll 的 mask 渐隐 #000 止点属透明度遮罩的
 *   实现色，不是展示用主题色（issue #240 明示不为其造令牌），由结构测试
 *   钉住既有形态防回退。
 * - 节点样式 #107 保证不回退：本文件不触碰 nodes.css，nodeTokens.test.ts
 *   全量用例继续通过即为其回归防线。
 *
 * Key State And Invariant Matrix（外观 × 交互态 × 对比度）：
 * | 状态/前提 | 动作/过渡 | 可观测结果 | 不变量 | 验证 |
 * | --- | --- | --- | --- | --- |
 * | 浅/深外观，常态 | 渲染三处前景 | 计算色 == 重构前字面量 #fff（视觉零变化） | 令牌化不改基线观感 | 黄金表 |
 * | 大纲集进入选中态 | .on 挂类 | 前景经 --on-brand：基线白、more 翻黑 | 品牌底前景全应用同一令牌行为（tokens.css 既有契约） | 黄金表 |
 * | danger 确认/删除悬停 | :hover / danger 挂类 | 前景经 --on-danger 恒定白 | 危险动作前景与其底色（--danger）成对经令牌进入 | 黄金表 |
 * | 浅 ↔ 深 ↔ more 切换 | 系统偏好切换 | 三处前景解析值 == 黄金基准 | 前景只随所属令牌变，不残留硬编码 | 黄金表（4 环境） |
 * | 令牌接线 | 渲染任意面板 | 三条规则引用的 var() 全部可解析 | 无失效 var（静默回落） | 接线测试 |
 * | 结构回归 | 新增面板样式 | color 声明零硬编码色值 | 新前景必须经 tokens.css 进入 | 结构测试 |
 * | 遮罩非回退 | 任意环境 | mask 渐隐仍为双前缀 linear-gradient #000 止点 | 遮罩实现色豁免不被扩大为展示色通行证 | 结构测试 |
 *
 * 未覆盖维度：并发/时序不适用（静态样式表）；--on-danger 白字在深色外观
 * danger 底（#ff6961）上的对比度约 2.8:1，与重构前逐位相同——按 issue #240
 * 口径「本次未实测它们的对比度，不宣称已违反特定对比度比例」作为已知边界
 * 记录（tokens.css 令牌注释与本测试黄金值共同钉住现状， remediation 归
 * 后续单）；--on-brand 翻黑后与品牌渐变内部中段的对比度凹陷同 edge-label
 * 契约（见 tokens.css --edge-label-bg 注释），由该令牌族既有用例管辖。
 * 已知边界：panels.css 其余 var() 接线（如 .pw-ai-cancel:hover 的
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

  it('遮罩实现色豁免保持既有形态：#000 止点仅在双前缀 mask 渐隐声明内', () => {
    let scroll: postcss.Rule | undefined
    panelsCss.walkRules((rule) => {
      if (rule.selector === '.pw-panel-scroll') scroll = rule
    })
    expect(scroll, '未找到 .pw-panel-scroll 规则').toBeDefined()
    const masked = (scroll!.nodes ?? []).filter(
      (node): node is postcss.Declaration =>
        node.type === 'decl' && node.prop.endsWith('mask-image'),
    )
    const props = masked.map((decl) => decl.prop).sort()
    expect(props).toEqual(['-webkit-mask-image', 'mask-image'])
    for (const decl of masked) {
      expect(decl.value).toContain('#000 ')
      // 展示色不得借遮罩豁免回流：mask 声明里只允许实现黑一种色字面量
      const hexes = decl.value.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
      expect([...new Set(hexes)]).toEqual(['#000'])
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

  it('品牌选中态前景经 --on-brand：基线双外观 #ffffff（视觉零变化），more 翻黑', () => {
    const rule = ruleOf('.pw-outline-ep-btn.on')
    expect(declOf(rule, 'background')).toBe('var(--brand-gradient)')
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
