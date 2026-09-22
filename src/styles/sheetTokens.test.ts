/**
 * 全部组件样式表对令牌体系的遵循契约（issue #278）。
 *
 * 契约来源：docs/ui-design.md 原则 2「语义色令牌，不硬编码颜色；文本与
 * 背景对比度 ≥ 4.5:1」、§2.1「组件只引用语义令牌」与 §2.6 三无障碍变体。
 * 与 issue #107（nodes.css）/ #240（panels.css）/ #261（home.css 菜单钮）
 * 的分表契约同一验证口径（postcss 解析真实样式表），本文件把结构、接线、
 * 配对三类断言推广到 src 下全部组件样式表：按 glob 自动发现，新增样式表
 * 无需登记即进入全部契约（不维护文件布局清单），消除「布线不全」这一
 * D33 根因。
 *
 * 范围界定（issue #278 验收标准）：
 * - 结构断言覆盖展示色属性（前景 color、背景与 background-image 长形、轮
 *   廓、SVG fill/stroke，以及 border 全部简写/长形——总体、四向、逻辑方向，
 *   按结构式分类而非枚举）；字面色含 hex、大小写不敏感的颜色函数与 CSS
 *   具名色；transparent（仅 alpha=0 无色相）与 currentcolor（继承而非字面）
 *   不计。box-shadow 是层级投影非主题展示色、mask-image 只消费 alpha 通道
 *   （遮罩语义另断言），两者不在字面色禁用范围。
 *   经展示色属性传递消费的局部自定义属性同样受禁：`.b { --fg: #fff; color:
 *   var(--fg) }` 不得绕过契约（消费关系沿局部属性值链传递闭包计算；仅被
 *   非展示属性消费的局部属性——如 React Flow 控件变量——不在展示色契约内）。
 * - 接线断言按「引用点活跃的全部支持环境」逐一验证：tokens.css 值链与局部
 *   定义值链均递归消解——令牌/局部变量自身引用缺失名、或仅在部分环境定义
 *   （如仅浅色媒体块内）而引用点无条件，均为悬空。带 fallback 的
 *   var(--x, v) 运行时不悬空，不计入接线违例（其中的字面色仍归结构契约）。
 *   样式表内的局部自定义属性只对定义规则自身及其后代规则可达
 *   （:root/html/body 视为全局）；逗号选择器逐分支判定——任一引用分支
 *   无可达定义即整条判悬空（该分支运行时计算色失效）。声明值为保证无效
 *   形态（initial，及全局作用域上退化为 initial 的 unset）的局部定义与
 *   令牌按断链处理；inherit/revert 静态不可判定，不在判定内（见未覆盖维度）。
 * - 已接受的例外不当作违例：用户内容色（海报压字/织线兜底/损坏占位，承
 *   载面依赖海报内容，同 tokens.css --on-saturated 理由）、遮罩（压字
 *   scrim / 模态压暗）、声明自洽状态对（settings.css 文件内记录决策）。
 *   每条例外是具名注册表项（表 + 选择器 + 属性/引用 + 已审计字面值 + 条数
 *   + 理由 + 引用），非广泛排除；结构例外绑定到具体值与出现条数，接线例外
 *   绑定到承载属性与出现条数——同属性换写其他字面色、新增第二条同值字面
 *   声明、超出已审计条数、为已豁免悬空引用换属性承载或新增第二条声明，
 *   均为新违例。注册表双向校验——新违例进不来，已修复或条数变动的表项
 *   必须更新（防藏）。
 * - 危险动作黄金接线断言取规则内该属性的**最后一条**声明（CSS 生效值），
 *   同属性前置声明不再遮蔽生效值；目标规则须唯一且无条件——媒体块内
 *   同名规则会使生效值随环境分叉，违背 #240 恒白决策的接线前提。
 * - 开放缺陷以跟踪单号入表：#262（品牌底固定白字 ×2）、#265（悬空
 *   --fill-tertiary ×1）；其修复落地时注册表同步收缩。
 * - 不重开 #240 危险色决策：--on-danger 恒白，深色底 ≈2.8:1 为已记录
 *   已知边界，不做对比度断言；本单只把该决策接线到 editor/nodes-settings
 *   四处字面 #fff（令牌恒值 #ffffff，视觉零变化）。
 *
 * Key State And Invariant Matrix（外观 × 对比度 × 交互态 × 布线）：
 * | 状态/前提 | 动作/过渡 | 可观测结果 | 不变量 | 验证 |
 * | --- | --- | --- | --- | --- |
 * | 新增组件样式表 | glob 发现 | 自动进入全部契约，无登记清单 | 布线不全不可悄然发生 | 发现测试 |
 * | 新增展示色字面声明（hex/大小写不敏感函数色/具名色；含 fill/stroke、background-image 与 border 全部简写/长形） | 结构扫描 | 非注册表项即失败（点名表/选择器/声明） | 展示色必须经 tokens.css 或具名例外 | 结构测试 |
 * | 局部自定义属性被展示色属性（传递）消费且值含字面色 | 结构扫描 | 按违例点名（同注册表豁免） | 字面色不得经局部变量别名进入展示位 | 结构测试 |
 * | 注册表项同属性换写其他字面色 / 新增第二条同值字面声明 / 超出已审计条数 | 结构扫描 | 按新违例点名（豁免绑定到值与条数） | 例外不覆盖未审计的值或条数 | 结构测试 |
 * | 注册表项对应声明被修复、换值或条数变动 | 结构反向校验 | 表项失配即失败 | 例外表不藏已修复项 | 结构测试 |
 * | 引用未定义 var()、令牌/局部定义值链引用缺失名（传递）、或定义为保证无效值（initial / 全局作用域 unset） | 接线扫描 | 失败点名（D38 类悬空引用） | 无失效 var 静默回落 | 接线测试 |
 * | 引用仅在无关选择器下定义的局部 var() | 接线扫描（作用域可达性） | 失败点名 | 局部定义只对自身/后代规则生效 | 接线测试 |
 * | 逗号选择器的任一引用分支无可达定义 | 接线扫描（逐分支可达） | 失败点名 | 每一分支运行时均须取得有效计算色 | 接线测试 |
 * | 引用点在某环境活跃而定义仅在其他环境成立（如仅浅色媒体块内定义） | 接线扫描（全部支持环境逐一） | 失败点名该环境 | 定义须覆盖引用活跃的每个环境 | 接线测试 |
 * | 已豁免悬空引用换属性承载或新增第二条声明 | 接线扫描（属性 + 条数比对） | 按新违例点名 | 接线豁免不扩张已知缺陷 | 接线测试 |
 * | 浅/深 × 基线/more × 基线/降透明度（8 环境） | 配对矩阵 | primary 全环境 ≥4.5、secondary more 升档 ≥4.5（§2.6） | 原则 2 按令牌配对成立（含 reduce-transparency 实色材质） | 配对测试 |
 * | 悬停态换填充 | 配对矩阵 | text-primary 于 fill-quaternary 承载面 ≥4.5 | hover 配对按既有契约 | 配对测试 |
 * | 危险动作 hover/确认 | 黄金接线（规则唯一无条件；生效值 = 属性最后一条声明） | 前景全部配对环境恒 #ffffff（#240 决策） | 危险前景经 --on-danger，生效值不随环境分叉 | 黄金测试 |
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
  return tokenValuesOf(postcss.parse(read(TOKEN_SHEET)), env)
}

function tokenValuesOf(root: postcss.Root, env: Env): Map<string, string> {
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
  walk(root)
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

/** 展示色属性（非 border 系）：字面色值必须经注册表豁免（box-shadow/遮罩除外）。 */
const DISPLAY_PROPS = new Set([
  'color',
  'background',
  'background-color',
  'background-image',
  'outline',
  'outline-color',
  'text-decoration',
  'text-decoration-color',
  'caret-color',
  'accent-color',
  'column-rule',
  'column-rule-color',
  'fill',
  'stroke',
])

/** border 系结构式分类：总体/四向/逻辑方向 × 简写或 -color 长形。 */
const BORDER_COLOR_PROP =
  /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?$/

/** 属性是否承载展示色（构造中的 border 字面色同样受禁）。 */
function isDisplayColorProp(prop: string): boolean {
  return DISPLAY_PROPS.has(prop) || BORDER_COLOR_PROP.test(prop)
}

/** CSS 函数名大小写不敏感（`RGB(...)` 与 `rgb(...)` 同为字面函数色）。 */
const COLOR_FUNCTION_OR_HEX =
  /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bhwb\(|\blab\(|\blch\(|\boklab\(|\boklch\(|\bcolor\(/i

/** CSS Color 4 全部具名色（148）；transparent/currentcolor 为关键字，不在此列。 */
const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black ' +
    'blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse ' +
    'chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta ' +
    'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite ' +
    'forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green ' +
    'greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender ' +
    'lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink ' +
    'lightsalmon lightseagreen lightskyblue lightslategray lightslategrey ' +
    'lightsteelblue lightyellow lime limegreen linen magenta maroon ' +
    'mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred ' +
    'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace ' +
    'olive olivedrab orange orangered orchid palegoldenrod palegreen ' +
    'paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown ' +
    'salmon sandybrown seagreen seashell sienna silver skyblue slateblue ' +
    'slategray slategrey snow springgreen steelblue tan teal thistle tomato ' +
    'turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
)

/** 独立标识符（非 var(--name) 片段、非函数名、非带单位数字）。 */
const BARE_IDENT = /(?<![\w-])[a-zA-Z]+(?![\w-(])/g

/** 声明值是否含字面色：hex / 颜色函数 / CSS 具名色（transparent 不计）。 */
function hasColorLiteral(value: string): boolean {
  if (COLOR_FUNCTION_OR_HEX.test(value)) return true
  for (const match of value.matchAll(BARE_IDENT)) {
    if (NAMED_COLORS.has(match[0].toLowerCase())) return true
  }
  return false
}

/** 值内全部 var() 引用名（含带 fallback 者；用于消费关系闭包）。 */
function allVarRefs(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!)
}

/** 值内无 fallback 的 var() 引用名（带 fallback 者运行时不悬空，不入接线）。 */
function noFallbackRefs(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]!)
}

/**
 * 展示色例外注册表（issue #278）：每项 = 表 + 选择器 + 属性 + 已审计的字面值
 * + 条数（默认 1）+ 理由 + 引用。豁免绑定到具体值与出现条数：同一属性换写
 * 其他字面色、新增第二条同值字面声明或超出已审计条数均为新违例。双向校验：
 * 命中违例必须在表内且不超条数；表项必须仍按已审计条数命中字面声明（修复
 * 落地或条数变动后更新表项，防例外表藏项）。开放缺陷以跟踪单号为引用。
 */
const STRUCTURE_EXCEPTIONS: Readonly<
  {
    sheet: string
    selector: string
    prop: string
    value: string
    count?: number
    reason: string
  }[]
> = [
  {
    sheet: 'src/home/home.css',
    selector: '.project-poster--weave',
    prop: 'background',
    value: '#1a1a1e',
    reason: '用户内容层：织线兜底恒深底（homeTokens.test.ts 未覆盖维度注）',
  },
  {
    sheet: 'src/home/home.css',
    selector: '.project-poster--broken',
    prop: 'background',
    value: '#232326',
    reason: '用户内容层：损坏占位恒深底（issue #123）',
  },
  {
    sheet: 'src/home/home.css',
    selector: '.project-poster--broken',
    prop: 'border',
    value: '1px dashed rgba(255, 255, 255, 0.28)',
    reason: '用户内容层：损坏占位虚线框',
  },
  {
    sheet: 'src/home/home.css',
    selector: '.project-poster--broken .project-poster-name',
    prop: 'color',
    value: 'rgba(255, 255, 255, 0.85)',
    reason: '用户内容层：损坏占位文本',
  },
  {
    sheet: 'src/home/home.css',
    selector: '.project-poster--broken .project-poster-stats',
    prop: 'color',
    value: 'rgba(255, 176, 122, 0.92)',
    reason: '用户内容层：损坏占位统计文本',
  },
  {
    sheet: 'src/home/home.css',
    selector: '.project-poster-caption',
    prop: 'background',
    value: 'linear-gradient(transparent, rgba(0, 0, 0, 0.68))',
    reason: '遮罩：海报压字渐变 scrim（§3.2，只承载 alpha）',
  },
  {
    sheet: 'src/home/home.css',
    selector: '.project-poster-name',
    prop: 'color',
    value: '#fff',
    reason:
      '用户内容前景：承载面依赖海报内容，无确定性对比面（同 tokens.css --on-saturated 理由）',
  },
  {
    sheet: 'src/home/home.css',
    selector: '.project-poster-stats',
    prop: 'color',
    value: 'rgba(255, 255, 255, 0.78)',
    reason: '用户内容前景：同 .project-poster-name',
  },
  {
    sheet: 'src/editor/editor.css',
    selector: '.pw-overlay',
    prop: 'background',
    value: 'rgba(0, 0, 0, 0.32)',
    reason: '遮罩：模态压暗 scrim（只承载 alpha）',
  },
  {
    sheet: 'src/editor/editor.css',
    selector: '.editor-tbtn-ai.on',
    prop: 'color',
    value: '#fff',
    reason: '开放缺陷：品牌底固定白字，配对修复归 #262',
  },
  {
    sheet: 'src/settings/settings.css',
    selector: '.settings-key-state.ok',
    prop: 'background',
    value: '#1e4629',
    reason: '声明自洽状态对（≈6.7:1，settings.css 文件内记录决策 S7924）',
  },
  {
    sheet: 'src/settings/settings.css',
    selector: '.settings-key-state.ok',
    prop: 'color',
    value: '#7ce69a',
    reason: '声明自洽状态对（同上）',
  },
  {
    sheet: 'src/settings/settings.css',
    selector: '.pw-ai-msg-user',
    prop: 'color',
    value: '#fff',
    reason: '开放缺陷：品牌底固定白字，配对修复归 #262',
  },
  {
    sheet: 'src/settings/settings.css',
    selector: '.pw-ai-ctx-toggle.on',
    prop: 'background',
    value: 'rgba(0, 179, 216, 0.12)',
    reason:
      '已知边界：accent-alt 浅色 wash 字面量未随外观切换（P3，#278 PR 披露，未跟踪）',
  },
]

/** 结构例外的唯一键：表|选择器|属性|字面值（值去首尾空白）。 */
function structureKey(
  sheet: string,
  selector: string,
  prop: string,
  value: string,
): string {
  return `${sheet}|${selector}|${prop}|${value.trim()}`
}

/**
 * 接线例外注册表：悬空 var() 引用按开放缺陷跟踪（#265）。绑定到承载属性
 * 与条数——已豁免引用换属性承载（如 background 改 color）或新增第二条同
 * 属性声明（实际条数 > 已审计）均按新违例点名，已知缺陷不因豁免而换位或
 * 扩张；属性或条数变动后须更新表项。
 */
const WIRING_EXCEPTIONS: Readonly<
  {
    sheet: string
    selector: string
    prop: string
    ref: string
    count?: number
    reason: string
  }[]
> = [
  {
    sheet: 'src/editor/panels/panels.css',
    selector: '.pw-ai-cancel:hover',
    prop: 'background',
    ref: '--fill-tertiary',
    count: 1,
    reason: '开放缺陷：未定义变量致悬停背景失效，归 #265',
  },
]

/** 接线验证环境全集：外观 × 对比度 × 透明度 × 动效（引用点活跃的全部支持环境）。 */
const WIRING_ENVS: Readonly<[string, Env][]> = (
  ['light', 'dark'] as const
).flatMap((scheme) =>
  (['no-preference', 'more'] as const).flatMap((contrast) =>
    (['no-preference', 'reduce'] as const).flatMap((transparency) =>
      (['no-reduce', 'reduce'] as const).map((motion): [string, Env] => [
        `${scheme}/${contrast}/${transparency}/${motion}`,
        { scheme, contrast, transparency, motion },
      ]),
    ),
  ),
)

/** 带上下文的声明：condition 为外层 at-rule 链（名 + 前置，空串 = 无条件）。 */
interface SheetDecl {
  selector: string
  condition: string
  prop: string
  value: string
}

/** 组件样式表的全部声明（含媒体块内），带选择器与 at-rule 条件上下文。 */
function* sheetDecls(root: postcss.Root): Generator<SheetDecl> {
  for (const node of root.nodes ?? []) yield* walkContainer(node, '')
}

function* walkContainer(
  node: postcss.ChildNode,
  condition: string,
): Generator<SheetDecl> {
  if (node.type === 'atrule') {
    const nested = `${condition}@${node.name} ${node.params};`
    for (const child of node.nodes ?? []) yield* walkContainer(child, nested)
  } else if (node.type === 'rule') {
    for (const child of node.nodes ?? []) {
      if (child.type === 'decl') {
        yield {
          selector: node.selector,
          condition,
          prop: child.prop,
          value: child.value,
        }
      }
    }
  }
}

describe('样式表发现（issue #278：契约覆盖全部组件样式表）', () => {
  it('发现集含令牌定义源与至少一张组件表，且每张组件表解析出展示色声明（新表自动入契约）', () => {
    expect(sheets.has(TOKEN_SHEET)).toBe(true)
    const components = [...sheets].filter(([sheet]) => sheet !== TOKEN_SHEET)
    expect(components.length).toBeGreaterThan(0)
    for (const [sheet, root] of components) {
      const displayDecls = [...sheetDecls(root)].filter((decl) =>
        isDisplayColorProp(decl.prop),
      )
      expect(displayDecls.length, `${sheet} 无展示色声明`).toBeGreaterThan(0)
    }
  })
})

describe('展示色结构契约（issue #278）', () => {
  it('展示色属性分类覆盖 border 全部简写/长形（四向与逻辑方向）、SVG fill/stroke 与 background-image；box-shadow 与尺寸类不算', () => {
    for (const prop of [
      'border',
      'border-top',
      'border-left',
      'border-inline-start',
      'border-block-end-color',
      'border-color',
      'outline',
      'fill',
      'stroke',
      'background-image',
    ]) {
      expect(isDisplayColorProp(prop), prop).toBe(true)
    }
    for (const prop of [
      'box-shadow',
      'border-width',
      'border-radius',
      'border-top-width',
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

  it('全部组件样式表的展示色声明不硬编码色值（具名例外注册表内、值一致且不超已审计条数）', () => {
    const audited = new Map(
      STRUCTURE_EXCEPTIONS.map((e) => [
        structureKey(e.sheet, e.selector, e.prop, e.value),
        e.count ?? 1,
      ]),
    )
    const offenders: string[] = []
    for (const [key, hit] of literalOccurrences()) {
      const audit = audited.get(key)
      if (audit === undefined) {
        offenders.push(`${hit.label}（${hit.count} 条，未审计）`)
      } else if (hit.count > audit) {
        offenders.push(`${hit.label}（${hit.count} 条 > 已审计 ${audit} 条）`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('经展示色传递消费的局部自定义属性不引入字面色（消费闭包按名计算，含间接消费）', () => {
    const root = postcss.parse(
      '.a { --fg: #fff; color: var(--fg); }\n' +
        '.b { --mid: var(--fg); background: var(--mid); }\n' +
        '.c { --shadow: 0 2px 8px rgba(0, 0, 0, 0.2); box-shadow: var(--shadow); }\n' +
        '.d { --unused: #fff; }',
    )
    const consumed = displayConsumedProps(root)
    expect(consumed.has('--fg'), '直接消费').toBe(true)
    expect(consumed.has('--mid'), '间接消费（经 --mid 值链）').toBe(true)
    expect(consumed.has('--shadow'), '仅被 box-shadow 消费不入展示色契约').toBe(
      false,
    )
    expect(consumed.has('--unused'), '未被消费').toBe(false)
  })

  it('注册表每项仍按已审计条数命中值一致的真实字面声明（修复/换值/条数变动后更新表项，防例外藏项）', () => {
    const live = literalOccurrences()
    const stale = STRUCTURE_EXCEPTIONS.filter((e) => {
      const key = structureKey(e.sheet, e.selector, e.prop, e.value)
      return (live.get(key)?.count ?? 0) !== (e.count ?? 1)
    })
    expect(
      stale.map(
        (e) =>
          `${e.sheet} ${e.selector} ${e.prop}: ${e.value}（期望 ${e.count ?? 1} 条，实际 ${live.get(structureKey(e.sheet, e.selector, e.prop, e.value))?.count ?? 0} 条）`,
      ),
      '以下注册表项已不再按已审计条数命中字面声明，应更新或删除：',
    ).toEqual([])
  })
})

/**
 * 经展示色属性（沿局部属性值链传递）消费的局部自定义属性名集合：从全部
 * 展示色声明的 var() 引用起做传递闭包。仅被非展示属性（如 box-shadow）消
 * 费的局部属性不在展示色契约内。
 */
function displayConsumedProps(root: postcss.Root): Set<string> {
  const locals = localDefinitions(root)
  const consumed = new Set<string>()
  const queue = [...sheetDecls(root)]
    .filter((decl) => isDisplayColorProp(decl.prop))
    .flatMap((decl) => allVarRefs(decl.value))
  while (queue.length > 0) {
    const name = queue.pop()!
    if (consumed.has(name)) continue
    consumed.add(name)
    for (const def of locals.get(name) ?? []) {
      queue.push(...allVarRefs(def.value))
    }
  }
  return consumed
}

/**
 * 全部组件样式表的字面展示色出现点（键 → 可读标签与条数）：展示色声明本
 * 身，加上经展示色传递消费的局部自定义属性声明；条数参与注册表双向比对。
 */
function literalOccurrences(): Map<string, { label: string; count: number }> {
  const out = new Map<string, { label: string; count: number }>()
  const bump = (sheet: string, decl: SheetDecl): void => {
    const key = structureKey(sheet, decl.selector, decl.prop, decl.value)
    const hit = out.get(key)
    if (hit) hit.count += 1
    else {
      out.set(key, {
        label: `${sheet} ${decl.selector} ${decl.prop}: ${decl.value.trim()}`,
        count: 1,
      })
    }
  }
  for (const [sheet, root] of sheets) {
    if (sheet === TOKEN_SHEET) continue
    const consumed = displayConsumedProps(root)
    for (const decl of sheetDecls(root)) {
      if (isDisplayColorProp(decl.prop) && hasColorLiteral(decl.value)) {
        bump(sheet, decl)
      } else if (
        decl.prop.startsWith('--') &&
        consumed.has(decl.prop) &&
        hasColorLiteral(decl.value)
      ) {
        bump(sheet, decl)
      }
    }
  }
  return out
}

/** 全局作用域选择器：其上的自定义属性对文档内任何规则可达。 */
const GLOBAL_SCOPES = new Set([':root', 'html', 'body', '*'])

/**
 * 自定义属性声明值是否为「保证无效」形态：initial 恒为保证无效值；unset
 * 在全局作用域（无父级可继承）上退化为 initial，同为保证无效。inherit /
 * revert 静态不可判定（取决于运行时父级与层叠），不在本判定内。
 */
function isGuaranteedInvalid(value: string, selector: string): boolean {
  const keyword = value.trim().toLowerCase()
  if (keyword === 'initial') return true
  if (keyword === 'unset') {
    return selector
      .split(',')
      .map((s) => s.trim())
      .every((s) => GLOBAL_SCOPES.has(s))
  }
  return false
}

/** 单个选择器 definer 是否覆盖 referencer 自身或其后代（兄弟组合器不算）。 */
function selectorReaches(definer: string, referencer: string): boolean {
  if (GLOBAL_SCOPES.has(definer) || definer === referencer) return true
  if (!referencer.startsWith(definer)) return false
  const rest = referencer.slice(definer.length)
  // 复合选择器延续（同一元素）或后代组合器（空白 / >）；兄弟组合器 + ~ 不可达。
  return /^[:.[#]/.test(rest) || /^(\s*>|\s+(?![+~]))/.test(rest)
}

/** 局部自定义属性的定义点：选择器 + 外层 at-rule 条件 + 声明值。 */
interface LocalDef {
  selector: string
  condition: string
  value: string
}

/**
 * at-rule 条件链在 env 下是否成立（空串无条件恒真）。条件链由 sheetDecls
 * 拼接为 `@media <params>;` 序列；仅 @media 段参与环境求值，其余 at-rule
 * （@keyframes/@supports 等）不随建模的环境维度变化，视为恒活跃。
 */
function conditionActive(condition: string, env: Env): boolean {
  if (condition === '') return true
  return condition
    .split(';')
    .map((seg) => seg.trim())
    .filter((seg) => seg.startsWith('@media '))
    .every((seg) => mediaMatches(seg.replace(/^@media\s+/, ''), env))
}

/**
 * 定义点列表是否选择器覆盖引用点：逗号选择器**逐分支**判定——每一个引用
 * 分支都须有定义方的某一分支覆盖（任一分支不可达即整条判悬空，该分支运行
 * 时计算色失效）。at-rule 条件与环境可达性由调用方按 env 判定。
 */
function scopeReaches(
  definers: readonly LocalDef[],
  referencer: { selector: string },
): boolean {
  const defs = definers.flatMap((def) =>
    def.selector.split(',').map((s) => s.trim()),
  )
  return referencer.selector
    .split(',')
    .map((s) => s.trim())
    .every((r) => defs.some((d) => selectorReaches(d, r)))
}

/** 本表局部自定义属性 → 全部定义点（含媒体块内，条件与声明值随定义点保留）。 */
function localDefinitions(root: postcss.Root): Map<string, LocalDef[]> {
  const out = new Map<string, LocalDef[]>()
  for (const decl of sheetDecls(root)) {
    if (!decl.prop.startsWith('--')) continue
    const list = out.get(decl.prop) ?? []
    list.push({
      selector: decl.selector,
      condition: decl.condition,
      value: decl.value,
    })
    out.set(decl.prop, list)
  }
  return out
}

/** 单个环境的接线上下文：env 生效的令牌值 + 本表局部定义。 */
interface WiringCtx {
  env: Env
  tokens: Map<string, string>
  locals: Map<string, LocalDef[]>
}

/**
 * tokens.css 内某令牌的值链在 env 下是否完整可解析：值为保证无效形态
 * （initial / :root 上 unset）直接判断链；值内无 fallback 的 var() 引用须
 * 均为 env 下已定义令牌且递归完整（环按 CSS 计算值时刻无效判断为断链）。
 * tokens.css 被排除在组件表扫描外，其内部断链由本函数兜住。
 */
function tokenChainResolves(
  name: string,
  ctx: WiringCtx,
  seen: ReadonlySet<string>,
): boolean {
  const value = ctx.tokens.get(name)
  if (value === undefined) return false
  if (isGuaranteedInvalid(value, ':root')) return false
  return noFallbackRefs(value).every(
    (ref) =>
      ctx.tokens.has(ref) &&
      !seen.has(ref) &&
      tokenChainResolves(ref, ctx, new Set([...seen, ref])),
  )
}

/**
 * 引用名在指定上下文（选择器 + 条件）与 env 下是否完整可解析：全局令牌
 * 走令牌值链；局部定义须 env 活跃、非保证无效值且值链在该定义点上下文
 * 递归完整，再要求引用的**每一分支**被某个完整定义分支覆盖（级联特异性
 * 未建模，见头注）。
 */
function refResolves(
  name: string,
  at: { selector: string; condition: string },
  ctx: WiringCtx,
  seen: ReadonlySet<string>,
): boolean {
  if (seen.has(name)) return false
  if (ctx.tokens.has(name)) {
    return tokenChainResolves(name, ctx, new Set([name]))
  }
  const next = new Set([...seen, name])
  const resolvable = (ctx.locals.get(name) ?? []).filter(
    (def) =>
      conditionActive(def.condition, ctx.env) &&
      !isGuaranteedInvalid(def.value, def.selector) &&
      noFallbackRefs(def.value).every((ref) =>
        refResolves(ref, def, ctx, next),
      ),
  )
  return resolvable.length > 0 && scopeReaches(resolvable, at)
}

/**
 * 表内在 env 下活跃声明的全部悬空 var() 引用：引用未定义名、令牌/局部
 * 定义值链断裂、定义仅在引用不活跃的其他环境成立、或逗号选择器任一分支
 * 无可达定义，均按悬空点名。
 */
function danglingRefs(
  root: postcss.Root,
  env: Env,
): { selector: string; ref: string }[] {
  const ctx: WiringCtx = {
    env,
    tokens: tokenValues(env),
    locals: localDefinitions(root),
  }
  const out: { selector: string; ref: string }[] = []
  for (const decl of sheetDecls(root)) {
    if (!conditionActive(decl.condition, env)) continue
    for (const ref of noFallbackRefs(decl.value)) {
      if (!refResolves(ref, decl, ctx, new Set())) {
        out.push({ selector: decl.selector, ref })
      }
    }
  }
  return out
}

/**
 * 全部组件样式表在至少一个支持环境悬空的 var() 引用出现点（键 → 可读标
 * 签与条数）：键绑定到承载属性；同一声明跨环境悬空只计一次，第二条同位
 * 声明计为新出现；条数参与接线注册表双向比对。
 */
function danglingOccurrences(): Map<string, { label: string; count: number }> {
  const out = new Map<string, { label: string; count: number }>()
  for (const [sheet, root] of sheets) {
    if (sheet === TOKEN_SHEET) continue
    const ctxs = WIRING_ENVS.map(([, env]) => ({
      env,
      tokens: tokenValues(env),
      locals: localDefinitions(root),
    }))
    for (const decl of sheetDecls(root)) {
      for (const ref of noFallbackRefs(decl.value)) {
        const dangles = ctxs.some(
          (ctx) =>
            conditionActive(decl.condition, ctx.env) &&
            !refResolves(ref, decl, ctx, new Set()),
        )
        if (!dangles) continue
        const key = `${sheet}|${decl.selector}|${decl.prop}|${ref}`
        const hit = out.get(key)
        if (hit) hit.count += 1
        else {
          out.set(key, {
            label: `${sheet} ${decl.selector} ${decl.prop} 引用 ${ref}`,
            count: 1,
          })
        }
      }
    }
  }
  return out
}

describe('令牌接线契约（issue #278）', () => {
  it('组件样式表引用的 var() 在全部支持环境完整可解析（含值链与逐分支可达；接线属性与条数不超已审计）', () => {
    const audited = new Map(
      WIRING_EXCEPTIONS.map((e) => [
        `${e.sheet}|${e.selector}|${e.prop}|${e.ref}`,
        e.count ?? 1,
      ]),
    )
    const offenders: string[] = []
    for (const [key, hit] of danglingOccurrences()) {
      const audit = audited.get(key)
      if (audit === undefined) {
        offenders.push(`${hit.label}（${hit.count} 条，未审计）`)
      } else if (hit.count > audit) {
        offenders.push(`${hit.label}（${hit.count} 条 > 已审计 ${audit} 条）`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('局部自定义属性仅对定义规则自身/后代可达；逗号选择器逐分支判定，任一分支不可达即假', () => {
    const def = (selector: string): LocalDef => ({
      selector,
      condition: '',
      value: '#000',
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
    const env: Env = {
      scheme: 'light',
      contrast: 'no-preference',
      transparency: 'no-preference',
      motion: 'no-reduce',
    }
    expect(danglingRefs(root, env)).toEqual([
      { selector: '.parent .child, .orphan', ref: '--local' },
    ])
  })

  it('at-rule 条件链按环境求值：无条件恒真，单特性与多特性链按 env 逐一判定', () => {
    const dark = '@media (prefers-color-scheme: dark);'
    const darkMore = `${dark}@media (prefers-contrast: more);`
    const motion = '@media (prefers-reduced-motion: reduce);'
    const light: Env = {
      scheme: 'light',
      contrast: 'no-preference',
      transparency: 'no-preference',
      motion: 'no-reduce',
    }
    const darkEnv: Env = { ...light, scheme: 'dark' }
    const darkMoreEnv: Env = { ...darkEnv, contrast: 'more' }
    const reduceMotionEnv: Env = { ...light, motion: 'reduce' }
    expect(conditionActive('', light)).toBe(true)
    expect(conditionActive(dark, light)).toBe(false)
    expect(conditionActive(dark, darkEnv)).toBe(true)
    expect(conditionActive(darkMore, darkEnv), '链上 AND 语义').toBe(false)
    expect(conditionActive(darkMore, darkMoreEnv)).toBe(true)
    expect(conditionActive(motion, light)).toBe(false)
    expect(conditionActive(motion, reduceMotionEnv)).toBe(true)
  })

  it('值链断裂的局部定义在消费点也判悬空（递归消解，不只查名存在）', () => {
    const root = postcss.parse(
      '.b { --chain: var(--missing); color: var(--chain); }',
    )
    const env: Env = {
      scheme: 'light',
      contrast: 'no-preference',
      transparency: 'no-preference',
      motion: 'no-reduce',
    }
    expect(danglingRefs(root, env)).toEqual([
      { selector: '.b', ref: '--missing' },
      { selector: '.b', ref: '--chain' },
    ])
  })

  it('tokens.css 值链断裂的令牌在其消费点判悬空（定义源不在组件扫描内，由链消解兜住）', () => {
    const env: Env = {
      scheme: 'light',
      contrast: 'no-preference',
      transparency: 'no-preference',
      motion: 'no-reduce',
    }
    const broken: WiringCtx = {
      env,
      tokens: tokenValuesOf(postcss.parse(':root { --a: var(--b); }'), env),
      locals: new Map(),
    }
    const intact: WiringCtx = {
      env,
      tokens: tokenValuesOf(
        postcss.parse(':root { --a: var(--b); --b: #fff; }'),
        env,
      ),
      locals: new Map(),
    }
    const at = { selector: '.x', condition: '' }
    expect(refResolves('--a', at, broken, new Set()), '链断裂').toBe(false)
    expect(refResolves('--a', at, intact, new Set()), '链完整').toBe(true)
  })

  it('保证无效形态的定义在消费点判悬空（initial 恒无效；全局作用域 unset 退化同判）', () => {
    const root = postcss.parse(
      '.a { --fg-init: initial; color: var(--fg-init); }\n' +
        '.b { --fg-ok: #fff; color: var(--fg-ok); }\n' +
        ':root { --root-unset: unset; }\n.c { color: var(--root-unset); }',
    )
    const env: Env = {
      scheme: 'light',
      contrast: 'no-preference',
      transparency: 'no-preference',
      motion: 'no-reduce',
    }
    expect(danglingRefs(root, env)).toEqual([
      { selector: '.a', ref: '--fg-init' },
      { selector: '.c', ref: '--root-unset' },
    ])
  })

  it('仅在部分环境成立的定义对其他环境下的活跃引用判悬空（逐环境验证）', () => {
    const root = postcss.parse(
      '@media (prefers-color-scheme: light) { .card { --only-light: #000 } }\n' +
        '.card { color: var(--only-light) }',
    )
    const envOf = (scheme: 'light' | 'dark'): Env => ({
      scheme,
      contrast: 'no-preference',
      transparency: 'no-preference',
      motion: 'no-reduce',
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
      scheme,
      contrast: 'no-preference',
      transparency: 'no-preference',
      motion: 'no-reduce',
    })
    expect(danglingRefs(root, envOf('dark'))).toEqual([])
    expect(danglingRefs(root, envOf('light'))).toEqual([
      { selector: '.card', ref: '--local' },
    ])
  })

  it('接线注册表每项仍按已审计属性与条数命中真实悬空引用（#265 修复、换属性或条数变动后更新/删表项）', () => {
    const live = danglingOccurrences()
    const stale = WIRING_EXCEPTIONS.filter((e) => {
      const hit = live.get(`${e.sheet}|${e.selector}|${e.prop}|${e.ref}`)
      return (hit?.count ?? 0) !== (e.count ?? 1)
    })
    expect(
      stale.map(
        (e) =>
          `${e.sheet} ${e.selector} ${e.prop} ${e.ref}（期望 ${e.count ?? 1} 条，实际 ${live.get(`${e.sheet}|${e.selector}|${e.prop}|${e.ref}`)?.count ?? 0} 条）`,
      ),
      '以下接线注册表项已不再按已审计属性与条数命中悬空引用，应更新或删除：',
    ).toEqual([])
  })
})

/**
 * 配对环境全集：浅/深 × 基线/more × 基线/降透明度（§2.6 全部变体组合，
 * 8 环境；动效不影响取色）。reduce-transparency 下材质令牌退化为实色
 * （tokens.css 提供独立取值），配对承诺须在实色材质上同样成立。
 */
const PAIR_ENVS: Readonly<[string, Env][]> = (
  ['light', 'dark'] as const
).flatMap((scheme) =>
  (['no-preference', 'more'] as const).flatMap((contrast) =>
    (['no-preference', 'reduce'] as const).map(
      (transparency): [string, Env] => [
        `${scheme}${contrast === 'more' ? '+more' : ''}${transparency === 'reduce' ? '+reduce' : ''}`,
        { scheme, contrast, transparency, motion: 'no-reduce' },
      ],
    ),
  ),
)

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

/**
 * 表内按完整选择器找规则：须**唯一且无条件**（不处于任何 at-rule 内）——
 * 媒体块内同名规则会使生效值随环境分叉，违背黄金接线「恒值」前提；同名
 * 重复规则使文本序后位遮蔽先位，定位失真。缺失/重复/条件化均抛错防测试
 * 静默空过。
 */
function ruleOf(sheet: string, selector: string): postcss.Rule {
  const matches: postcss.Rule[] = []
  sheets.get(sheet)!.walkRules((rule) => {
    if (rule.selector === selector) matches.push(rule)
  })
  if (matches.length === 0) throw new Error(`未找到规则 ${sheet} ${selector}`)
  if (matches.length > 1) {
    throw new Error(
      `${sheet} ${selector} 有 ${matches.length} 条同名规则，须唯一`,
    )
  }
  const rule = matches[0]!
  if (rule.parent?.type !== 'root') {
    throw new Error(`${sheet} ${selector} 处于 at-rule 内，须无条件规则`)
  }
  return rule
}

/** 规则内该属性的最后一条声明（CSS 生效值）；缺失抛错防测试静默空过。 */
function declOf(rule: postcss.Rule, prop: string): string {
  const decls = rule.nodes.filter(
    (node): node is postcss.Declaration =>
      node.type === 'decl' && node.prop === prop,
  )
  const last = decls[decls.length - 1]
  if (!last) throw new Error(`${rule.selector} 缺少 ${prop} 声明`)
  return last.value
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

  it('黄金接线取生效值：同属性后置声明不被前置声明遮蔽（CSS 最后声明生效）', () => {
    const rule = postcss.parse(
      '.x { color: var(--on-danger); color: var(--text-primary); }',
    ).first as postcss.Rule
    expect(declOf(rule, 'color')).toBe('var(--text-primary)')
  })

  it('--on-danger 全部配对环境（含 more × reduce 组合）消解恒 #ffffff（视觉零变化；深色底 ≈2.8:1 为 #240 已记录边界，不重开）', () => {
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
