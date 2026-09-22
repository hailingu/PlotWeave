/**
 * 全部组件样式表对令牌体系的遵循契约（issue #278）。
 *
 * 契约来源：docs/ui-design.md 原则 2「语义色令牌，不硬编码颜色；文本与
 * 背景对比度 ≥ 4.5:1」、§2.1「组件只引用语义令牌」与 §2.6 三无障碍变体。
 * 与 issue #107（nodes.css）/ #240（panels.css）/ #261（home.css 菜单钮）
 * 的分表契约同一验证口径（postcss 解析真实样式表），本文件把结构、接线、
 * 配对三类断言推广到 src 下全部组件样式表：按 glob 自动发现，新增样式表
 * 必须先进入本契约的期望清单才能通过，消除「布线不全」这一 D33 根因。
 *
 * 范围界定（issue #278 验收标准）：
 * - 结构断言覆盖展示色属性（前景 color、背景、描边、轮廓）；box-shadow
 *   是层级投影非主题展示色、mask-image 只消费 alpha 通道（遮罩语义另断
 *   言），两者不在字面色禁用范围。
 * - 已接受的例外不当作违例：用户内容色（海报压字/织线兜底/损坏占位，承
 *   载面依赖海报内容，同 tokens.css --on-saturated 理由）、遮罩（压字
 *   scrim / 模态压暗）、声明自洽状态对（settings.css 文件内记录决策）。
 *   每条例外是具名注册表项（表 + 选择器 + 属性 + 理由 + 引用），非广泛
 *   排除；注册表双向校验——新违例进不来，已修复的表项必须删除（防藏）。
 * - 开放缺陷以跟踪单号入表：#262（品牌底固定白字 ×2）、#265（悬空
 *   --fill-tertiary ×1）；其修复落地时注册表同步收缩。
 * - 不重开 #240 危险色决策：--on-danger 恒白，深色底 ≈2.8:1 为已记录
 *   已知边界，不做对比度断言；本单只把该决策接线到 editor/nodes-settings
 *   四处字面 #fff（令牌恒值 #ffffff，视觉零变化）。
 *
 * Key State And Invariant Matrix（外观 × 对比度 × 交互态 × 布线）：
 * | 状态/前提 | 动作/过渡 | 可观测结果 | 不变量 | 验证 |
 * | --- | --- | --- | --- | --- |
 * | 新增组件样式表 | glob 发现 | 期望清单失配即失败，新表进入全部契约 | 布线不全不可悄然发生 | 发现测试 |
 * | 新增展示色字面声明 | 结构扫描 | 非注册表项即失败（点名表/选择器/声明） | 展示色必须经 tokens.css 或具名例外 | 结构测试 |
 * | 注册表项对应声明被修复 | 结构反向校验 | 表项失配即失败 | 例外表不藏已修复项 | 结构测试 |
 * | 引用未定义 var() | 接线扫描 | 失败点名（D38 类悬空引用） | 无失效 var 静默回落 | 接线测试 |
 * | 浅/深 × 基线/more | 配对矩阵 | primary 全环境 ≥4.5、secondary more 升档 ≥4.5（§2.6） | 原则 2 按语义令牌配对成立 | 配对测试 |
 * | 悬停态换填充 | 配对矩阵 | text-primary 于 fill-quaternary 承载面 ≥4.5 | hover 配对按既有契约 | 配对测试 |
 * | 危险动作 hover/确认 | 黄金接线 | 前景四环境恒 #ffffff（#240 决策） | 危险前景经 --on-danger | 黄金测试 |
 * | 遮罩渐变 | alpha 剖析 | 首末色标全透明、内部全不透明 | 遮罩只消费 alpha | 遮罩测试 |
 *
 * 未覆盖维度：真实 WebView 像素实测未运行；品牌底两处配对归 #262、悬空
 * 变量归 #265 跟踪；accent-alt 焦点描边/青 wash（.pw-ai-ctx-toggle.on）的
 * 非文本 3:1 未断言——无既有决策，不在本单开新前沿（PR 披露）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path: string): string =>
  readFileSync(join(repoRoot, path), 'utf8')

/** 令牌定义源：作为唯一定义方排除在组件样式表契约外。 */
const TOKEN_SHEET = 'src/styles/tokens.css'

/** 期望的组件样式表全集（发现测试失配即提示先接入契约）。 */
const EXPECTED_SHEETS: readonly string[] = [
  'src/editor/editor.css',
  'src/editor/nodes/nodes.css',
  'src/editor/nodes/settings/settings.css',
  'src/editor/panels/documents.css',
  'src/editor/panels/panels.css',
  'src/editor/panels/settings-detail.css',
  'src/home/home.css',
  'src/index.css',
  'src/settings/settings.css',
]

/** glob 发现 src 下全部 CSS（posix 相对路径，含 tokens.css）。 */
function discoverCssSheets(): string[] {
  const entries = readdirSync(join(repoRoot, 'src'), {
    encoding: 'utf8',
    recursive: true,
  })
  return entries
    .filter((name) => name.endsWith('.css'))
    .map((name) => `src/${name.replace(/\\/g, '/')}`)
    .sort()
}

const sheets = new Map(
  discoverCssSheets().map((path) => [path, postcss.parse(read(path))]),
)

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
  walk(postcss.parse(read(TOKEN_SHEET)))
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

interface Rgb {
  r: number
  g: number
  b: number
}

type Paint = Rgb & { a: number }

/** 解析 #rgb/#rrggbb/#rrggbbaa 与逗号语法 rgb()/rgba()；其余形式返回 null。 */
function parsePaint(input: string): Paint | null {
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
function blendOver(fg: Paint, bg: Rgb): Rgb {
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

/** 渐变遮罩色标提取：函数形式取到配对右括号，其余取首个空白分隔词。 */
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

/** 遮罩色标 alpha：hex / rgb() 逗号与空格语法 / 具名色（transparent=0）。 */
function stopAlpha(token: string): number {
  const value = token.trim()
  const percent = (raw: string): number =>
    raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw)
  if (/^transparent$/i.test(value)) return 0
  const paint = parsePaint(value)
  if (paint) return paint.a
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

/** 展示色属性：这些属性的字面色值必须经注册表豁免（box-shadow/遮罩除外）。 */
const DISPLAY_PROPS = new Set([
  'color',
  'background',
  'background-color',
  'border',
  'border-color',
  'outline',
  'outline-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'text-decoration-color',
  'caret-color',
])

const COLOR_LITERAL =
  /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bhwb\(|\blab\(|\blch\(|\boklab\(|\boklch\(|\bcolor\(/

/**
 * 展示色例外注册表（issue #278）：每项 = 表 + 选择器 + 属性 + 理由 + 引用。
 * 双向校验：命中违例必须在表内；表项必须仍命中一条字面声明（修复落地后
 * 删除表项，防例外表藏已修复/不存在的项）。开放缺陷以跟踪单号为引用。
 */
const STRUCTURE_EXCEPTIONS: Readonly<
  { sheet: string; selector: string; prop: string; reason: string }[]
> = [
  {
    sheet: 'src/home/home.css',
    selector: '.project-poster--weave',
    prop: 'background',
    reason: '用户内容层：织线兜底恒深底（homeTokens.test.ts 未覆盖维度注）',
  },
  {
    sheet: 'src/home/home.css',
    selector: '.project-poster--broken',
    prop: 'background',
    reason: '用户内容层：损坏占位恒深底（issue #123）',
  },
  {
    sheet: 'src/home/home.css',
    selector: '.project-poster--broken',
    prop: 'border',
    reason: '用户内容层：损坏占位虚线框',
  },
  {
    sheet: 'src/home/home.css',
    selector: '.project-poster--broken .project-poster-name',
    prop: 'color',
    reason: '用户内容层：损坏占位文本',
  },
  {
    sheet: 'src/home/home.css',
    selector: '.project-poster--broken .project-poster-stats',
    prop: 'color',
    reason: '用户内容层：损坏占位统计文本',
  },
  {
    sheet: 'src/home/home.css',
    selector: '.project-poster-caption',
    prop: 'background',
    reason: '遮罩：海报压字渐变 scrim（§3.2，只承载 alpha）',
  },
  {
    sheet: 'src/home/home.css',
    selector: '.project-poster-name',
    prop: 'color',
    reason:
      '用户内容前景：承载面依赖海报内容，无确定性对比面（同 tokens.css --on-saturated 理由）',
  },
  {
    sheet: 'src/home/home.css',
    selector: '.project-poster-stats',
    prop: 'color',
    reason: '用户内容前景：同 .project-poster-name',
  },
  {
    sheet: 'src/editor/editor.css',
    selector: '.pw-overlay',
    prop: 'background',
    reason: '遮罩：模态压暗 scrim（只承载 alpha）',
  },
  {
    sheet: 'src/editor/editor.css',
    selector: '.editor-tbtn-ai.on',
    prop: 'color',
    reason: '开放缺陷：品牌底固定白字，配对修复归 #262',
  },
  {
    sheet: 'src/settings/settings.css',
    selector: '.settings-key-state.ok',
    prop: 'background',
    reason: '声明自洽状态对（≈6.7:1，settings.css 文件内记录决策 S7924）',
  },
  {
    sheet: 'src/settings/settings.css',
    selector: '.settings-key-state.ok',
    prop: 'color',
    reason: '声明自洽状态对（同上）',
  },
  {
    sheet: 'src/settings/settings.css',
    selector: '.pw-ai-msg-user',
    prop: 'color',
    reason: '开放缺陷：品牌底固定白字，配对修复归 #262',
  },
  {
    sheet: 'src/settings/settings.css',
    selector: '.pw-ai-ctx-toggle.on',
    prop: 'background',
    reason:
      '已知边界：accent-alt 浅色 wash 字面量未随外观切换（P3，#278 PR 披露，未跟踪）',
  },
]

/** 接线例外注册表：悬空 var() 引用按开放缺陷跟踪（#265）。 */
const WIRING_EXCEPTIONS: Readonly<
  { sheet: string; selector: string; ref: string; reason: string }[]
> = [
  {
    sheet: 'src/editor/panels/panels.css',
    selector: '.pw-ai-cancel:hover',
    ref: '--fill-tertiary',
    reason: '开放缺陷：未定义变量致悬停背景失效，归 #265',
  },
]

/** 组件样式表的全部声明（含媒体块内），带选择器上下文。 */
function* sheetDecls(
  root: postcss.Root,
): Generator<{ selector: string; prop: string; value: string }> {
  for (const node of root.nodes ?? []) yield* walkContainer(node)
}

function* walkContainer(
  node: postcss.ChildNode,
): Generator<{ selector: string; prop: string; value: string }> {
  if (node.type === 'atrule') {
    for (const child of node.nodes ?? []) yield* walkContainer(child)
  } else if (node.type === 'rule') {
    for (const child of node.nodes ?? []) {
      if (child.type === 'decl') {
        yield {
          selector: node.selector,
          prop: child.prop,
          value: child.value,
        }
      }
    }
  }
}

describe('样式表发现（issue #278：契约覆盖全部组件样式表）', () => {
  it('src 下 CSS 全集 = 令牌定义源 + 期望组件表清单（新增样式表须先接入契约）', () => {
    expect(discoverCssSheets()).toEqual([...EXPECTED_SHEETS, TOKEN_SHEET])
  })
})

describe('展示色结构契约（issue #278）', () => {
  it('全部组件样式表的展示色声明不硬编码色值（具名例外注册表内除外）', () => {
    const allowed = new Set(
      STRUCTURE_EXCEPTIONS.map((e) => `${e.sheet}|${e.selector}|${e.prop}`),
    )
    const offenders: string[] = []
    for (const [sheet, root] of sheets) {
      if (sheet === TOKEN_SHEET) continue
      for (const decl of sheetDecls(root)) {
        if (
          DISPLAY_PROPS.has(decl.prop) &&
          COLOR_LITERAL.test(decl.value) &&
          !allowed.has(`${sheet}|${decl.selector}|${decl.prop}`)
        ) {
          offenders.push(
            `${sheet} ${decl.selector} ${decl.prop}: ${decl.value.trim()}`,
          )
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('注册表每项仍命中一条真实字面声明（修复落地后删表项，防例外藏项）', () => {
    const live = new Set<string>()
    for (const [sheet, root] of sheets) {
      for (const decl of sheetDecls(root)) {
        if (DISPLAY_PROPS.has(decl.prop) && COLOR_LITERAL.test(decl.value)) {
          live.add(`${sheet}|${decl.selector}|${decl.prop}`)
        }
      }
    }
    const stale = STRUCTURE_EXCEPTIONS.filter(
      (e) => !live.has(`${e.sheet}|${e.selector}|${e.prop}`),
    )
    expect(
      stale.map((e) => `${e.sheet} ${e.selector} ${e.prop}`),
      '以下注册表项已不再命中任何字面声明，应删除：',
    ).toEqual([])
  })
})

describe('令牌接线契约（issue #278）', () => {
  it('组件样式表引用的 var() 全部在 tokens.css 或本表有定义（无悬空回落）', () => {
    const allowed = new Set(
      WIRING_EXCEPTIONS.map((e) => `${e.sheet}|${e.selector}|${e.ref}`),
    )
    const offenders: string[] = []
    for (const [sheet, root] of sheets) {
      if (sheet === TOKEN_SHEET) continue
      const localDefs = new Set<string>()
      for (const decl of sheetDecls(root)) {
        if (decl.prop.startsWith('--')) localDefs.add(decl.prop)
      }
      const tokenDefs = tokenValues({
        scheme: 'light',
        contrast: 'no-preference',
        transparency: 'no-preference',
      })
      for (const decl of sheetDecls(root)) {
        for (const match of decl.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
          const ref = match[1]!
          if (tokenDefs.has(ref) || localDefs.has(ref)) continue
          if (!allowed.has(`${sheet}|${decl.selector}|${ref}`)) {
            offenders.push(`${sheet} ${decl.selector} 引用 ${ref}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('接线注册表每项仍命中一条真实悬空引用（#265 修复落地后删表项）', () => {
    const dangling = new Set<string>()
    for (const [sheet, root] of sheets) {
      const localDefs = new Set<string>()
      for (const decl of sheetDecls(root)) {
        if (decl.prop.startsWith('--')) localDefs.add(decl.prop)
      }
      const tokenDefs = tokenValues({
        scheme: 'light',
        contrast: 'no-preference',
        transparency: 'no-preference',
      })
      for (const decl of sheetDecls(root)) {
        for (const match of decl.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
          const ref = match[1]!
          if (!tokenDefs.has(ref) && !localDefs.has(ref)) {
            dangling.add(`${sheet}|${decl.selector}|${ref}`)
          }
        }
      }
    }
    const stale = WIRING_EXCEPTIONS.filter(
      (e) => !dangling.has(`${e.sheet}|${e.selector}|${e.ref}`),
    )
    expect(
      stale.map((e) => `${e.sheet} ${e.selector} ${e.ref}`),
      '以下接线注册表项已不再悬空，应删除：',
    ).toEqual([])
  })
})

/** 配对环境：浅/深 × 基线/more（§2.6 文本对比度升一档）。 */
const PAIR_ENVS: Readonly<[string, Env][]> = [
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
]

/** 承载面链：自底向顶逐层合成（底面全不透明，半透明层按 alpha 叠加）。 */
const SURFACES: Readonly<{ name: string; chain: string[] }[]> = [
  { name: 'surface-window', chain: ['--surface-window'] },
  { name: 'surface-canvas', chain: ['--surface-canvas'] },
  { name: 'surface-card', chain: ['--surface-card', '--surface-window'] },
  {
    name: 'material-titlebar',
    chain: ['--material-titlebar', '--surface-window'],
  },
  {
    name: 'material-sidebar',
    chain: ['--material-sidebar', '--surface-window'],
  },
  {
    name: 'fill-quaternary-on-window',
    chain: ['--fill-quaternary', '--surface-window'],
  },
  {
    name: 'fill-quaternary-on-titlebar',
    chain: ['--fill-quaternary', '--material-titlebar', '--surface-window'],
  },
]

/** 链合成承载面：令牌逐层消解为颜色并自底向顶叠加（非颜色值抛错）。 */
function compositeSurface(
  chain: readonly string[],
  tokens: Map<string, string>,
): Rgb {
  let acc: Rgb | undefined
  for (const name of [...chain].reverse()) {
    const paint = parsePaint(resolveChain(tokens.get(name)!, tokens))
    if (!paint) throw new Error(`承载面令牌 ${name} 非颜色值`)
    acc = acc === undefined ? paint : blendOver(paint, acc)
  }
  if (!acc) throw new Error('承载面链为空')
  return acc
}

/** 文本令牌消解为渲染色（半透明前景由调用方按需合成）。 */
function tokenPaint(name: string, tokens: Map<string, string>): Paint {
  const paint = parsePaint(resolveChain(tokens.get(name)!, tokens))
  if (!paint) throw new Error(`文本令牌 ${name} 非颜色值`)
  return paint
}

/** 断言前景令牌于承载面链上 ≥ 4.5:1（半透明前景先合成到承载面）。 */
function expectReadable(
  fgName: string,
  chain: readonly string[],
  tokens: Map<string, string>,
  label: string,
): void {
  const bg = compositeSurface(chain, tokens)
  const fg = tokenPaint(fgName, tokens)
  const rendered = fg.a >= 1 ? fg : blendOver(fg, bg)
  const ratio = contrastRatio(rendered, bg)
  expect(ratio, `${label} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
}

describe('语义令牌配对契约（issue #278：原则 2 + §2.6）', () => {
  it('一级文本于全部承载面（窗口/画布/卡片/材质/悬停填充）四环境 ≥ 4.5:1', () => {
    for (const [envName, env] of PAIR_ENVS) {
      const tokens = tokenValues(env)
      for (const surface of SURFACES) {
        expectReadable(
          '--text-primary',
          surface.chain,
          tokens,
          `${envName} text-primary on ${surface.name}`,
        )
      }
    }
  })

  it('次级文本于全部承载面在 more 对比度下升档 ≥ 4.5:1（基线为既有设计，§2.6）', () => {
    for (const [envName, env] of PAIR_ENVS.filter(([name]) =>
      name.endsWith('more'),
    )) {
      const tokens = tokenValues(env)
      for (const surface of SURFACES) {
        expectReadable(
          '--text-secondary',
          surface.chain,
          tokens,
          `${envName} text-secondary on ${surface.name}`,
        )
      }
    }
  })

  it('关键操作按钮前景/背景配对四环境 ≥ 4.5:1（确定性配对令牌）', () => {
    for (const [envName, env] of PAIR_ENVS) {
      const tokens = tokenValues(env)
      expectReadable(
        '--control-primary-fg',
        ['--control-primary-bg'],
        tokens,
        `${envName} control-primary`,
      )
    }
  })

  it('danger 作为文本色于窗口/卡片承载面四环境 ≥ 4.5:1（错误横幅/键态错误文案）', () => {
    for (const [envName, env] of PAIR_ENVS) {
      const tokens = tokenValues(env)
      for (const surfaceName of ['surface-window', 'surface-card']) {
        const chain = SURFACES.find((s) => s.name === surfaceName)!.chain
        expectReadable(
          '--danger',
          chain,
          tokens,
          `${envName} danger on ${surfaceName}`,
        )
      }
    }
  })
})

/** 危险动作前景接线（#240 决策）：editor/nodes-settings 四处消费点。 */
const DANGER_RULES: Readonly<{ sheet: string; selector: string }[]> = [
  { sheet: 'src/editor/editor.css', selector: '.editor-menu-danger:hover' },
  { sheet: 'src/editor/editor.css', selector: '.pw-dialog-danger' },
  {
    sheet: 'src/editor/nodes/settings/settings.css',
    selector: '.pw-set-danger:hover',
  },
  {
    sheet: 'src/editor/nodes/settings/settings.css',
    selector: '.pw-set-x:hover',
  },
]

/** 表内按完整选择器找规则（含媒体块；缺失抛错防测试静默空过）。 */
function ruleOf(sheet: string, selector: string): postcss.Rule {
  let found: postcss.Rule | undefined
  sheets.get(sheet)!.walkRules((rule) => {
    if (rule.selector === selector) found = rule
  })
  if (!found) throw new Error(`未找到规则 ${sheet} ${selector}`)
  return found
}

function declOf(rule: postcss.Rule, prop: string): string {
  const decl = rule.nodes.find(
    (node): node is postcss.Declaration =>
      node.type === 'decl' && node.prop === prop,
  )
  if (!decl) throw new Error(`${rule.selector} 缺少 ${prop} 声明`)
  return decl.value
}

describe('危险动作前景接线（#240 决策补齐，issue #278）', () => {
  it('四处危险前景经 --on-danger、底经 --danger（字面接线，不残留 #fff）', () => {
    for (const { sheet, selector } of DANGER_RULES) {
      const rule = ruleOf(sheet, selector)
      expect(declOf(rule, 'color'), `${sheet} ${selector} color`).toBe(
        'var(--on-danger)',
      )
      expect(
        declOf(rule, 'background'),
        `${sheet} ${selector} background`,
      ).toBe('var(--danger)')
    }
  })

  it('--on-danger 四环境消解恒 #ffffff（视觉零变化；深色底 ≈2.8:1 为 #240 已记录边界，不重开）', () => {
    for (const [envName, env] of PAIR_ENVS) {
      expect(resolveChain('var(--on-danger)', tokenValues(env)), envName).toBe(
        '#ffffff',
      )
    }
  })
})

describe('遮罩语义契约（issue #278：遮罩只消费 alpha）', () => {
  it('全部组件样式表的 linear-gradient 遮罩首末色标全透明、内部全不透明', () => {
    const checked: string[] = []
    for (const [sheet, root] of sheets) {
      if (sheet === TOKEN_SHEET) continue
      for (const decl of sheetDecls(root)) {
        if (!decl.prop.endsWith('mask-image')) continue
        if (!/^linear-gradient\(/i.test(decl.value.trim())) {
          throw new Error(`${sheet} ${decl.prop} 非 linear-gradient，未建模`)
        }
        const alphas = maskStopAlphas(decl.value)
        const label = `${sheet} ${decl.selector} ${decl.prop}`
        checked.push(label)
        expect(alphas.length, `${label} 色标数`).toBeGreaterThanOrEqual(3)
        expect(alphas[0], `${label} 顶边全透明`).toBe(0)
        expect(alphas[alphas.length - 1], `${label} 底边全透明`).toBe(0)
        for (const [i, alpha] of alphas.slice(1, -1).entries()) {
          expect(alpha, `${label} 内部色标 ${i} 须全不透明`).toBe(1)
        }
      }
    }
    expect(
      checked.length,
      '至少覆盖 panels/settings 两处既有遮罩',
    ).toBeGreaterThanOrEqual(4)
  })
})
