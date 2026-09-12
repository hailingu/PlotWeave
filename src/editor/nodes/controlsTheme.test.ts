// @vitest-environment happy-dom
/**
 * 画布缩放控件（React Flow Controls）主题验证（issue #93；PR #96 首轮评审强化）。
 *
 * 机器契约：
 * - @xyflow/react v12 官方主题变量：dist/style.css 以
 *   var(--xy-controls-button-background-color, …-default) 等链取色，变量名是
 *   React Flow 公开主题 API；
 * - 应用设计令牌（docs/ui-design.md §2、src/styles/tokens.css）：组件只引用
 *   语义令牌；
 * - 注入顺序：应用侧按 src/index.css 的 @import 序注入，RF 样式表属懒加载
 *   chunk（App.tsx 惰性 import EditorView）必然最后注入。
 *
 * 可观测不变量：无论样式表注入顺序如何，按钮的计算 background/color 在两种
 * 外观下都必须等于对应语义令牌的解析值。happy-dom 的 getComputedStyle 不解析
 * 两级 var 链（--a: var(--b) 形态消费为空），无法直接对渲染树取计算值；本文件
 * 以 postcss 解析真实生产样式表组合，选择器匹配用 Element.matches，按 CSS 作者
 * 源级联（!important → 特异性 → 顺序）与自定义属性继承 + var() 回退链消解出
 * 计算值后断言。四条自检用例向测试内注入四类回归形态（接线缺失、更高特异性
 * 错误硬编码、更高特异性覆盖自定义属性、!important），钉住消解模型能复现并
 * 捕获缺陷（评审 5187020501 / 5187126810 / 5187174354）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window, type Element as HappyDOMElement } from 'happy-dom'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

// happy-dom 环境会用其 URL 实现替换全局 URL，路径一律走 node:path 确定性拼接。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8')

/** 模拟用户偏好环境（不启用增强对比 / 降透明 / 减动态）。 */
function userEnv(scheme: 'light' | 'dark') {
  return { scheme, contrast: 'no-preference', transparency: 'no-preference', motion: 'no-reduce' } as const
}

type Env = ReturnType<typeof userEnv>

const LIGHT = userEnv('light')
const DARK = userEnv('dark')

/** 仓库样式表实际使用的 @media 特性 → 环境字段；未建模特性在求值时抛错。 */
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
          throw new Error(`级联模型未建模的 media 特性: ${raw.trim()}`)
        }
        return env[MEDIA_FEATURES[key]] === feature[2]
      }),
    )
}

interface Ruled {
  rule: postcss.Rule
  order: number
}

/** 展开各层规则：进入求值为真的 @media；order 即级联顺序。 */
function flattenRules(layers: postcss.Root[], env: Env): Ruled[] {
  const out: Ruled[] = []
  const walk = (container: postcss.Root | postcss.AtRule): void => {
    for (const node of container.nodes ?? []) {
      if (node.type === 'rule') out.push({ rule: node, order: out.length })
      else if (node.type === 'atrule' && node.name === 'media' && mediaMatches(node.params, env)) walk(node)
    }
  }
  for (const layer of layers) walk(layer)
  return out
}

/** 应用样式层：按 index.css 的 @import 声明序逐文件解析（生产注入顺序契约）。 */
function appLayers(): postcss.Root[] {
  const index = postcss.parse(read('src/index.css'))
  const imports: string[] = []
  index.walkAtRules('import', (at) => {
    imports.push(at.params.replace(/^['"]|['"]$/g, ''))
  })
  return imports.map((file) => postcss.parse(read(`src/${file}`)))
}

const rfLayer = (): postcss.Root => postcss.parse(read('node_modules/@xyflow/react/dist/style.css'))

/** 与运行态一致的控件结构：html(:root) → body → .canvas-root → .react-flow → 控件面板 → 按钮。 */
function fixture(): { chain: HappyDOMElement[] } {
  const window = new Window()
  const document = window.document
  document.body.innerHTML = [
    '<div class="canvas-root">',
    '<div class="react-flow">',
    '<div class="react-flow__panel react-flow__controls vertical bottom left">',
    '<button type="button" class="react-flow__controls-button react-flow__controls-zoomin" aria-label="Zoom In">',
    '<svg viewBox="0 0 32 32"><path d="M32 18.133H18.133V32h-4.266V18.133H0v-4.266h13.867V0h4.266v13.867H32z"></path></svg>',
    '</button>',
    '</div>',
    '</div>',
    '</div>',
  ].join('')
  const chain = [
    document.documentElement,
    document.body,
    document.querySelector('.canvas-root')!,
    document.querySelector('.react-flow')!,
    document.querySelector('.react-flow__controls')!,
    document.querySelector('.react-flow__controls-button')!,
  ]
  return { chain }
}

type Specificity = readonly [ids: number, classes: number, types: number]

/** 选择器特异性（id, 类/伪类, 元素）；仓库样式表无属性选择器。 */
function specificity(selector: string): Specificity {
  let ids = 0
  let classes = 0
  let types = 0
  for (const [, kind, name] of selector.matchAll(/([.#:])([\w-]+)|([\w-]+)/g)) {
    if (kind === '#') ids += 1
    else if (kind === '.' || kind === ':') classes += 1
    else if (name) types += 1
  }
  return [ids, classes, types]
}

function higherSpec(a: Specificity, b: Specificity): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]
}

function sameSpec(a: Specificity, b: Specificity): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

/** 级联取胜者候选：值 + 命中特异性 + 源顺序 + 是否 !important。 */
interface Candidate {
  value: string
  spec: Specificity
  order: number
  important: boolean
}

/** 作者源级联判定：!important 先于特异性与顺序，同重要性再比特异性与源顺序。 */
function beats(candidate: Candidate, best: Candidate): boolean {
  if (candidate.important !== best.important) return candidate.important
  return higherSpec(candidate.spec, best.spec) || (sameSpec(candidate.spec, best.spec) && candidate.order > best.order)
}

type Scopes = Map<HappyDOMElement, Map<string, string>>

/**
 * 收集作用于链上各元素的自定义属性声明。与普通属性同法按作者源级联取胜者
 * （!important → 特异性 → 顺序）：首轮评审 5187020501 指出无条件的后写覆盖
 * 会让更早的更高特异性声明在模型中被顶掉；次轮评审 5187126810 指出自定义
 * 属性收集同样必须走级联；三轮评审 5187174354 补齐 !important 维度。
 */
function collectScopes(chain: HappyDOMElement[], ruled: Ruled[]): Scopes {
  const winners = new Map<HappyDOMElement, Map<string, Candidate>>()
  for (const { rule, order } of ruled) {
    for (const node of rule.nodes) {
      if (node.type !== 'decl' || !node.prop.startsWith('--')) continue
      for (const element of chain) {
        const spec = winningSelectorSpec(element, rule.selector)
        if (!spec) continue
        let scope = winners.get(element)
        if (!scope) winners.set(element, (scope = new Map()))
        const candidate: Candidate = { value: node.value, spec, order, important: node.important }
        const best = scope.get(node.prop)
        if (!best || beats(candidate, best)) scope.set(node.prop, candidate)
      }
    }
  }
  const scopes: Scopes = new Map()
  for (const [element, props] of winners) {
    scopes.set(element, new Map([...props].map(([name, winner]) => [name, winner.value])))
  }
  return scopes
}

/** 自定义属性取值：沿祖先链继承查找。 */
function lookupVar(scopes: Scopes, element: HappyDOMElement, name: string): string | undefined {
  for (let node: HappyDOMElement | null = element; node; node = node.parentElement) {
    const value = scopes.get(node)?.get(name)
    if (value !== undefined) return value
  }
  return undefined
}

/** 文本中括号深度为零处的首个逗号下标；无则 -1。 */
function topLevelComma(text: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) return i
  }
  return -1
}

/** 解析值中全部 var() 引用（含嵌套回退链）；未定义且无回退返回 null（计算值失效）。 */
function resolveValue(value: string, scopes: Scopes, element: HappyDOMElement, depth = 0): string | null {
  const normalize = (resolved: string): string => resolved.replace(/\s+/g, ' ').trim()
  if (depth > 12) throw new Error('var() 解析深度超限（疑似循环引用）')
  const start = value.indexOf('var(')
  if (start === -1) return normalize(value)
  let level = 1 // 已计入 var( 的左括号
  let end = -1
  for (let i = start + 4; i < value.length; i += 1) {
    if (value[i] === '(') level += 1
    else if (value[i] === ')') {
      level -= 1
      if (level === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) throw new Error(`var() 括号不匹配: ${value}`)
  const inner = value.slice(start + 4, end)
  const comma = topLevelComma(inner)
  const name = (comma === -1 ? inner : inner.slice(0, comma)).trim()
  const fallback = comma === -1 ? '' : inner.slice(comma + 1)
  const defined = lookupVar(scopes, element, name)
  const replacement =
    defined !== undefined
      ? resolveValue(defined, scopes, element, depth + 1)
      : fallback.trim() !== ''
        ? resolveValue(fallback, scopes, element, depth + 1)
        : null
  if (replacement === null) return null
  const tail = resolveValue(`${value.slice(0, start)}${replacement}${value.slice(end + 1)}`, scopes, element, depth + 1)
  return tail === null ? null : normalize(tail)
}

/** 命中按钮的选择器中特异性最高者的特异性；无命中为 undefined。 */
function winningSelectorSpec(button: HappyDOMElement, selectorList: string): Specificity | undefined {
  let best: Specificity | undefined
  for (const selector of selectorList.split(',')) {
    let hit: boolean
    try {
      hit = button.matches(selector.trim())
    } catch {
      continue
    }
    if (!hit) continue
    const spec = specificity(selector)
    if (!best || higherSpec(spec, best)) best = spec
  }
  return best
}

/** 按钮某属性的计算值：作者源级联（!important → 特异性 → 顺序）取胜出声明后经 var 链消解。 */
function computedProp(
  button: HappyDOMElement,
  ruled: Ruled[],
  scopes: Scopes,
  prop: 'background' | 'color',
): string | null {
  let best: Candidate | undefined
  for (const { rule, order } of ruled) {
    const spec = winningSelectorSpec(button, rule.selector)
    if (!spec) continue
    for (const node of rule.nodes) {
      if (node.type !== 'decl' || node.prop !== prop) continue
      const candidate: Candidate = { value: node.value, spec, order, important: node.important }
      if (!best || beats(candidate, best)) best = candidate
    }
  }
  if (!best) return null
  return resolveValue(best.value, scopes, button)
}

/** 令牌在按钮作用域的解析值（断言基准取自令牌声明本身，不硬编码色值）。 */
function tokenValue(scopes: Scopes, button: HappyDOMElement, name: string): string {
  const resolved = resolveValue(`var(${name})`, scopes, button)
  if (resolved === null) throw new Error(`令牌 ${name} 在按钮作用域无法解析`)
  return resolved
}

const stylesheet = postcss.parse(read('src/editor/nodes/nodes.css'))

/** 按精确选择器取规则；同选择器多条时返回首条。 */
function rule(selector: string): postcss.Rule | undefined {
  return stylesheet.nodes.find(
    (node): node is postcss.Rule => node.type === 'rule' && node.selector === selector,
  )
}

function declarations(selected: postcss.Rule): Map<string, string> {
  return new Map(
    selected.nodes
      .filter((node): node is postcss.Declaration => node.type === 'decl')
      .map((node) => [node.prop, node.value]),
  )
}

describe('画布控件主题接线机制（issue #93）', () => {
  it('容器经 React Flow 官方主题变量引用应用语义令牌', () => {
    const controls = rule('.react-flow__controls')
    expect(controls).toBeDefined()
    const decls = declarations(controls!)
    expect(decls.get('--xy-controls-button-background-color')).toBe('var(--surface-card)')
    expect(decls.get('--xy-controls-button-background-color-hover')).toBe('var(--fill-quaternary)')
    expect(decls.get('--xy-controls-button-color')).toBe('var(--text-primary)')
    expect(decls.get('--xy-controls-button-color-hover')).toBe('var(--text-primary)')
    expect(decls.get('--xy-controls-button-border-color')).toBe('var(--border-hairline)')
  })

  it('键盘聚焦态以品牌色描边可辨', () => {
    const focus = rule('.react-flow__controls-button:focus-visible')
    expect(focus).toBeDefined()
    expect(declarations(focus!).get('outline')).toContain('var(--accent)')
  })
})

describe('控件计算样式：生产样式表组合级联（PR #96 评审强化）', () => {
  const buttonOf = () => {
    const { chain } = fixture()
    return { button: chain[chain.length - 1]!, chain }
  }

  it.each(['light', 'dark'] as const)('%s 外观：生产序与反序注入下计算色均等于令牌解析值', (kind) => {
    const env = kind === 'light' ? LIGHT : DARK
    const { button, chain } = buttonOf()
    const compositions = [
      [...appLayers(), rfLayer()], // 生产：RF 属懒加载 chunk 必然最后注入
      [rfLayer(), ...appLayers()], // 反序：不变量要求与注入顺序无关
    ]
    for (const layers of compositions) {
      const ruled = flattenRules(layers, env)
      const scopes = collectScopes(chain, ruled)
      expect(computedProp(button, ruled, scopes, 'background')).toBe(tokenValue(scopes, button, '--surface-card'))
      expect(computedProp(button, ruled, scopes, 'color')).toBe(tokenValue(scopes, button, '--text-primary'))
    }
  })

  it('自检：应用接线缺失时按钮回落 RF 浅色默认（复现 issue #93 机制）', () => {
    const { button, chain } = buttonOf()
    const ruled = flattenRules([postcss.parse(read('src/styles/tokens.css')), rfLayer()], DARK)
    const scopes = collectScopes(chain, ruled)
    const background = computedProp(button, ruled, scopes, 'background')
    expect(background).toBe(tokenValue(scopes, button, '--xy-controls-button-background-color-default'))
    expect(background).not.toBe(tokenValue(scopes, button, '--surface-card'))
  })

  it('自检：更高特异性选择器注入错误硬编码会胜出并被捕获（评审 5187020501 触发条件）', () => {
    const { button, chain } = buttonOf()
    const rogue = postcss.parse('div.canvas-root .react-flow__controls-button { background: #ffffff; }')
    const ruled = flattenRules([...appLayers(), rogue, rfLayer()], DARK)
    const scopes = collectScopes(chain, ruled)
    const background = computedProp(button, ruled, scopes, 'background')
    expect(background).toBe('#ffffff')
    expect(background).not.toBe(tokenValue(scopes, button, '--surface-card'))
  })

  it('自检：更高特异性选择器覆盖自定义属性会胜出并被捕获（评审 5187126810 触发条件）', () => {
    const { button, chain } = buttonOf()
    const rogue = postcss.parse(
      '.canvas-root .react-flow__controls { --xy-controls-button-background-color: #ffffff; }',
    )
    const layers = appLayers()
    layers.splice(layers.length - 1, 0, rogue) // 注入于 nodes.css 层之前：特异性须胜出而非靠顺序
    const ruled = flattenRules([...layers, rfLayer()], DARK)
    const scopes = collectScopes(chain, ruled)
    const background = computedProp(button, ruled, scopes, 'background')
    expect(background).toBe('#ffffff')
    expect(background).not.toBe(tokenValue(scopes, button, '--surface-card'))
  })

  it('自检：!important 无视特异性与顺序取胜并被捕获（评审 5187174354 触发条件）', () => {
    const { button, chain } = buttonOf()
    // 与 RF 令牌规则同特异性、且注入在更早的应用层：仅 !important 使其胜出
    const rogue = postcss.parse('.react-flow__controls-button { background: #ffffff !important; }')
    const layers = appLayers()
    layers.splice(layers.length - 1, 0, rogue)
    const ruled = flattenRules([...layers, rfLayer()], DARK)
    const scopes = collectScopes(chain, ruled)
    const background = computedProp(button, ruled, scopes, 'background')
    expect(background).toBe('#ffffff')
    expect(background).not.toBe(tokenValue(scopes, button, '--surface-card'))
  })
})
