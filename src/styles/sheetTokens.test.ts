/**
 * 全部组件样式表对令牌体系的遵循契约（issue #278）。
 *
 * 契约来源：docs/ui-design.md 原则 2「语义色令牌，不硬编码颜色；文本与
 * 背景对比度 ≥ 4.5:1」、§2.1「组件只引用语义令牌」与 §2.6 三无障碍变体。
 * 与 issue #107（nodes.css）/ #240（panels.css）/ #261（home.css 菜单钮）
 * 的分表契约同一验证口径（postcss 解析真实样式表），本文件把结构、接线、
 * 配对三类断言推广到 src 下全部组件样式表：按 glob 自动发现，新增样式表
 * 无需登记即进入全部契约（不维护文件布局清单，不要求每张表包含展示色），
 * 消除「布线不全」这一 D33 根因。
 *
 * 范围界定（issue #278 验收标准）：
 * - 结构断言覆盖展示色属性（前景 color、背景与 background-image 长形、
 *   轮廓、text-shadow、SVG fill/stroke，以及 border 全部简写/长形——总体、
 *   四向、逻辑方向与 border-image(-source) 长形，按结构式分类而非枚举；
 *   标准属性名先按 ASCII 大小写不敏感归一再分类，自定义属性名大
 *   小写保持原样）；字面色含 hex、大小写不敏感的颜色函数与 CSS 具名色；
 *   transparent（仅 alpha=0 无色相）与 currentcolor（继承而非字面）不计。
 *   box-shadow 是层级投影非主题展示色、mask-image 只消费 alpha 通道（遮罩
 *   语义另断言），两者不在字面色禁用范围。
 *   经展示色属性传递消费的局部自定义属性同样受禁：`.b { --fg: #fff; color:
 *   var(--fg) }` 不得绕过契约（消费关系沿局部属性值链传递闭包计算；仅被
 *   非展示属性消费的局部属性——如 React Flow 控件变量——不在展示色契约内）。
 *   展示色引用的解析值须按属性文法相容——非颜色令牌叶子（把 --radius-sm
 *   的尺寸值或 --weight 的裸数值 600 用进 color）与不支持图像的属性上
 *   的渐变/url() 均按违例点名。background/background-image/border-image(-source)
 *   接受图像；SVG fill/stroke 仅额外接受 URL 绘制引用。逐选择器分支解析局部遮蔽与
 *   fallback，空回退值不能独立作为展示色声明。纯颜色属性校验完整顶层值，
 *   不允许颜色前后夹带尺寸/数值/多余词形；边框颜色保留合法多值列表。
 * - 接线断言按「引用点活跃的全部支持环境」逐一验证：tokens.css 值链与局部
 *   定义值链均递归消解——令牌/局部变量自身引用缺失名、或仅在部分环境定义
 *   （如仅浅色媒体块内）而引用点无条件，均为悬空。带 fallback 的
 *   var(--x, v) 与展示色类型扫描共用取值规则，只诊断实际选中路径的悬空名；
 *   主值有效时不检查备用路径，失效时递归进入 fallback。环检测仍包含备用
 *   路径的依赖，其中的字面色仍归结构契约。
 *   样式表内的局部自定义属性只对定义规则自身及其后代规则可达
 *   （:root/html/body 视为全局），且**遮蔽同名根令牌**——分支被可达局
 *   部定义覆盖时按局部值判定，保证无效的遮蔽不因根令牌存在而放行；逗号
 *   选择器逐分支判定——任一引用分支无可达定义即整条判悬空。同选择器同条件的
 *   重复定义按层叠取胜出处：同一组内 !important 声明优先于普通声明，同重要
 *   性再取源序后位；组在输出中的位置按该组最后一次出现的源序排列，不因
 *   Map 键首次插入位置而提前——后续基线定义不被先前同选择器异条件定义错误
 *   遠盖。跨选择器特异性未建模。声明值为保证无效形态（initial，及全局作用
 *   域上退化为 initial 的 unset）的局部定义与令牌按断链处理；inherit/revert
 *   静态不可判定，不在判定内（见未覆盖维度）。
 * - 已接受的例外不当作违例：用户内容色（海报压字/织线兜底/损坏占位，承
 *   载面依赖海报内容，同 tokens.css --on-saturated 理由）、遮罩（压字
 *   scrim / 模态压暗）、声明自洽状态对（settings.css 文件内记录决策）。
 *   每条例外是具名注册表项（表 + 选择器 + 属性/引用 + 已审计字面值 + 条数
 *   + 理由 + 引用），非广泛排除；结构例外绑定到具体值与出现条数，接线例外
 *   绑定到承载属性与出现条数——同属性换写其他字面色、新增第二条同值字面
 *   声明、超出已审计条数、为已豁免悬空引用换属性承载或新增第二条声明，
 *   均为新违例。注册表双向校验——新违例进不来，已修复或条数变动的表项
 *   必须更新（防藏）。
 * - 危险动作黄金接线断言取规则内该属性的**生效值**：属性名先按标准大
 *   小写归一再比较（与展示色分类同一归一点），!important 声明优先
 *   于普通声明，同重要性取源序最后一条——前置 !important 不被其后的普通
 *   声明覆盖；目标规则须唯一且无条件——媒体块内同名规则会使生效值随环境
 *   分叉，违背 #240 恒白决策的接线前提。唯一性判定按选择器列表逐分支：后续
 *   规则若在逗号分支中含目标选择器（如 `.other, .pw-dialog-danger { ... }`）仍能
 *   以同等特异性覆盖，也计入命中，不按整选择器字符串相等。
 * - 开放缺陷以跟踪单号入表：#262（品牌底固定白字 ×2）、#265（悬空
 *   --fill-tertiary ×1）；其修复落地时注册表同步收缩。
 * - 不重开 #240 危险色决策：--on-danger 恒白，深色底 ≈2.8:1 为已记录
 *   已知边界，不做对比度断言；本单只把该决策接线到 editor/nodes-settings
 *   四处字面 #fff（令牌恒值 #ffffff，视觉零变化）。
 *
 * Key State And Invariant Matrix（外观 × 对比度 × 交互态 × 布线）：
 * | 状态/前提 | 动作/过渡 | 可观测结果 | 不变量 | 验证 |
 * | --- | --- | --- | --- | --- |
 * | 新增组件样式表（包括仅布局/动画或空表） | glob 发现 | 自动进入全部契约，无登记清单或展示色条数要求 | 布线不全不可悄然发生 | 发现探针与无展示色夹具 |
 * | 新增展示色字面声明（hex/大小写不敏感函数色/具名色；含 fill/stroke、background-image、border-image(-source) 与 border 全部简写/长形） | 结构扫描 | 非注册表项即失败（点名表/选择器/声明） | 展示色必须经 tokens.css 或具名例外 | 结构测试 |
 * | 展示色属性名为非标准大小写（如 `Color`） | 分类前归一 | 仍按标准属性分类，字面色不因大小写绕过 | 标准属性名 ASCII 大小写不敏感 | 分类与集成语义用例 |
 * | 局部自定义属性被展示色属性（传递）消费且值含字面色 | 结构扫描 | 按违例点名（同注册表豁免） | 字面色不得经局部变量别名进入展示位 | 结构测试 |
 * | 展示色引用解析为不相容值（尺寸/裸数值叶子；不接受图像的属性上的渐变/URL） | 逐环境校验属性 | 按违例点名；合法背景图像及 SVG URL 通过 | 图像必须由支持该语法的属性消费 | 结构与图像文法测试 |
 * | 缺失/initial/断链/循环变量带 fallback，或有效主值带无效 fallback | 解析实际生效值（含嵌套回退） | 无效值及独立空值报错，有效主值/回退通过 | fallback 不绕过消费属性类型校验，主值有效时不消费回退 | fallback 取值测试 |
 * | 主变量有效而备用路径悬空，或主值按环境/分支失效 | 接线仅遍历被选中的路径 | 未选备用路径通过，选中的缺失名被点名 | 接线与类型扫描使用相同作用域和取值规则 | 接线实际取值路径测试 |
 * | 纯颜色值含颜色与多余尺寸/数值/词形，或边框/阴影合法含多个成分 | 校验完整顶层颜色值并区分属性类别 | 纯颜色混合值报错，合法简写/列表通过 | 一个颜色成分不能使整条无效纯颜色值通过 | 完整纯颜色值测试 |
 * | 逗号选择器各分支的局部同名定义不同，或仅部分环境活跃 | 逐分支、逐环境解析遮蔽值 | 仅无效分支报错，无局部定义的分支取根令牌 | 各分支只消费自身可达活跃的定义 | 分支取值测试 |
 * | 注册表项同属性换写其他字面色 / 新增第二条同值字面声明 / 超出已审计条数 | 结构扫描 | 按新违例点名（豁免绑定到值与条数） | 例外不覆盖未审计的值或条数 | 结构测试 |
 * | 注册表项对应声明被修复、换值或条数变动 | 结构反向校验 | 表项失配即失败 | 例外表不藏已修复项 | 结构测试 |
 * | 引用未定义 var()、令牌/局部定义值链引用缺失名（传递）、或定义为保证无效值（initial / 全局作用域 unset） | 接线扫描 | 失败点名（D38 类悬空引用） | 无失效 var 静默回落 | 接线测试 |
 * | 同选择器同条件内多条局部定义含 !important | 局部取胜扫描 | 重要声明优先于普通声明，无论源序 | 局部自定义属性也遵循重要性优先级 | 接线与类型集成语义用例 |
 * | 基线定义、媒体块定义、后续基线定义三者同名依次出现 | 取胜排序 | 按真实源序选中最后一条，不因 Map 键插入位置误判 | 同名定义的胜出位置按真实源序，非分组首次插入位置 | 接线集成语义用例 |
 * | 媒体块内 !important 定义与无条件后位普通定义跨活跃条件分组共存 | 跨分组取胜 | 重要声明仍胜出，不因其条件分组位置在无条件后位定义之前而被覆盖 | 接线与类型集成语义用例 |
 * | 引用仅在无关选择器下定义的局部 var() | 接线扫描（作用域可达性） | 失败点名 | 局部定义只对自身/后代规则生效 | 接线测试 |
 * | 逗号选择器的任一引用分支无可达定义 | 接线扫描（逐分支可达） | 失败点名 | 每一分支运行时均须取得有效计算色 | 接线测试 |
 * | 同选择器同条件的后位定义为保证无效值 | 接线扫描（层叠取后位） | 失败点名 | 生效定义按源序后位判定，先位有效定义不遮蔽 | 接线测试 |
 * | 可达局部定义与根令牌同名且保证无效 | 接线扫描（局部遮蔽优先） | 失败点名 | 遮蔽分支按局部值判定，根令牌不救 | 接线测试 |
 * | 引用点在某环境活跃而定义仅在其他环境成立（如仅浅色媒体块内定义） | 接线扫描（全部支持环境逐一） | 失败点名该环境 | 定义须覆盖引用活跃的每个环境 | 接线测试 |
 * | 已豁免悬空引用换属性承载或新增第二条声明 | 接线扫描（属性 + 条数比对） | 按新违例点名 | 接线豁免不扩张已知缺陷 | 接线测试 |
 * | 浅/深 × 基线/more × 基线/降透明度（8 环境） | 配对矩阵 | primary 全环境 ≥4.5、secondary more 升档 ≥4.5（§2.6） | 原则 2 按令牌配对成立（含 reduce-transparency 实色材质） | 配对测试 |
 * | 悬停态换填充 | 配对矩阵 | text-primary 于 fill-quaternary 承载面 ≥4.5 | hover 配对按既有契约 | 配对测试 |
 * | 危险动作 hover/确认 | 黄金接线（规则唯一无条件——包括逗号分支内的同分支覆盖；属性名归一；生效值按重要性再取源序最后一条） | 前景全部配对环境恒 #ffffff（#240 决策） | 危险前景经 --on-danger，生效值不随环境分叉且不被普通声明/大小写变体/同等特异性分支逆转 | 黄金测试 |
 * | 遮罩渐变 | alpha 剖析 | 首末色标全透明、内部全不透明 | 遮罩只消费 alpha | 遮罩测试 |
 *
 * 未覆盖维度：真实 WebView 像素实测未运行；品牌底两处配对归 #262、悬空
 * 变量归 #265 跟踪；accent-alt 焦点描边/青 wash（.pw-ai-ctx-toggle.on）的
 * 非文本 3:1 未断言——无既有决策，不在本单开新前沿（PR 披露）。
 * 值解析仍为静态子集，非完整 CSS 文法/层叠引擎；复杂选择器及跨选择器
 * 特异性与颜色函数内部参数未建模。审查处理记录见
 * docs/reviews/pr-288-review-5275978899.md；纯值校验由 cssColorContract.ts 负责。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import { colorTokenOf, colorTypeOk, hasColorLiteral } from './cssColorContract'

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

/** 展示色属性（非 border-color 系）：字面色值必须经注册表豁免（box-shadow/遮罩除外）。 */
const DISPLAY_PROPS = new Set([
  'color',
  'background',
  'background-image',
  'outline',
  'outline-color',
  'text-decoration',
  'text-decoration-color',
  'text-shadow',
  'caret-color',
  'accent-color',
  'column-rule',
  'column-rule-color',
  'fill',
  'stroke',
  'border-image',
  'border-image-source',
])

/** border 系结构式分类：总体/四向/逻辑方向 × 简写或 -color 长形。 */
const BORDER_COLOR_PROP =
  /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?$/

/** 属性是否承载展示色（构造中的 border 字面色同样受禁）。 */
function isDisplayColorProp(prop: string): boolean {
  return DISPLAY_PROPS.has(prop) || BORDER_COLOR_PROP.test(prop)
}

/** 值内全部 var() 引用名（含带 fallback 者；用于消费关系闭包）。 */
function allVarRefs(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!)
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

/** 带上下文的声明：condition 为外层 at-rule 链（名 + 前置，空串 = 无条件）；important 供局部自定义属性按重要性选胜。 */
interface SheetDecl {
  selector: string
  condition: string
  prop: string
  value: string
  important: boolean
}

/** 标准属性名 ASCII 大小写不敏感，归一为小写；自定义属性名保持大小写敏感。 */
function normalizeProp(prop: string): string {
  return prop.startsWith('--') ? prop : prop.toLowerCase()
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
          prop: normalizeProp(child.prop),
          value: child.value,
          important: child.important === true,
        }
      }
    }
  }
}

describe('样式表发现（issue #278：契约覆盖全部组件样式表）', () => {
  it('发现集含令牌定义源与组件表，新表自动进入扫描且不要求展示色声明数量', () => {
    expect(sheets.has(TOKEN_SHEET)).toBe(true)
    const components = [...sheets].filter(([sheet]) => sheet !== TOKEN_SHEET)
    expect(components.length).toBeGreaterThan(0)
  })
})

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

describe('展示色结构：全表扫描与注册表（issue #278）', () => {
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

  it('展示色属性的 var() 引用解析后按属性文法相容：逐环境与选择器分支点名无效值', () => {
    const offenders: string[] = []
    for (const [sheet, root] of sheets) {
      if (sheet === TOKEN_SHEET) continue
      for (const [envName, env] of WIRING_ENVS) {
        offenders.push(
          ...displayTypeErrors(root, env).map(
            (error) => `${sheet} [${envName}] 解析为类型不相容值: ${error}`,
          ),
        )
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

/** 局部自定义属性的定义点：选择器 + 外层 at-rule 条件 + 声明值 + 重要性。 */
interface LocalDef {
  selector: string
  condition: string
  value: string
  important: boolean
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

/** 本表局部自定义属性 → 全部定义点（含媒体块内，条件、声明值与重要性随定义点保留）。 */
function localDefinitions(root: postcss.Root): Map<string, LocalDef[]> {
  const out = new Map<string, LocalDef[]>()
  for (const decl of sheetDecls(root)) {
    if (!decl.prop.startsWith('--')) continue
    const list = out.get(decl.prop) ?? []
    list.push({
      selector: decl.selector,
      condition: decl.condition,
      value: decl.value,
      important: decl.important,
    })
    out.set(decl.prop, list)
  }
  return out
}

/**
 * 重要性优先于源序的取胜：非空列表中若存在重要声明/定义，只在其中取源序最后一项；
 * 否则退回全部项取最后一项。CSS 重要性优先于源序，且跨条件分组仍成立——
 * 媒体块内的 !important 不因其条件在无条件后位定义之前而被覆盖。
 */
function pickWinner<T extends { important: boolean }>(
  list: readonly T[],
): T | undefined {
  if (list.length === 0) return undefined
  const important = list.filter((item) => item.important)
  const pool = important.length > 0 ? important : list
  return pool[pool.length - 1]
}

/**
 * 同选择器同条件的重复定义按层叠取胜出处：同一组内 !important 声明优先于
 * 普通声明，同重要性再取源序后位（`.a { --fg: 4px !important; --fg: var(--x) }`
 * 生效的是前位的 `4px`）。组在输出中的位置按该组**最后一次出现**的源序
 * 排列（先 delete 再 set 把键移至 Map 末尾），避免后续基线定义覆盖先前媒体块
 * 定义时被错误识为“早于”媒体块定义。跨选择器的特异性/顺序胜负
 * 未建模，见头注未覆盖维度。
 */
function effectiveDefs(defs: readonly LocalDef[]): LocalDef[] {
  const groups = new Map<string, LocalDef[]>()
  for (const def of defs) {
    const key = `${def.selector}|${def.condition}`
    const list = groups.get(key) ?? []
    list.push(def)
    groups.delete(key)
    groups.set(key, list)
  }
  return [...groups.values()].map((list) => pickWinner(list)!)
}

/** 单个环境的接线上下文：env 生效的令牌值 + 本表局部定义。 */
interface WiringCtx {
  env: Env
  tokens: Map<string, string>
  locals: Map<string, LocalDef[]>
}

/** 当前值只访问实际选中的 var() 路径；未选中的 fallback 不形成悬空诊断。 */
function unresolvedValueRefs(
  value: string,
  scope: Map<string, string>,
): string[] {
  const refs: string[] = []
  let rest = value
  while (rest.includes('var(')) {
    const start = rest.indexOf('var(')
    const call = colorTokenOf(rest.slice(start))
    const args = call.slice(4, -1)
    const comma = args.indexOf(',')
    const name = (comma < 0 ? args : args.slice(0, comma)).trim()
    if (resolveDisplayValue(`var(${name})`, scope) === null) {
      if (comma < 0) refs.push(name)
      else refs.push(...unresolvedValueRefs(args.slice(comma + 1), scope))
    }
    rest = rest.slice(start + call.length)
  }
  return refs
}

/** 活跃环境内逐选择器分支解析，合并同一声明的悬空名，保持注册表按声明计数。 */
function unresolvedRefsIn(decl: SheetDecl, ctx: WiringCtx): string[] {
  if (!conditionActive(decl.condition, ctx.env)) return []
  return [
    ...new Set(
      decl.selector
        .split(',')
        .flatMap((branch) =>
          unresolvedValueRefs(
            decl.value,
            valueScopeIn({ ...decl, selector: branch.trim() }, ctx),
          ),
        ),
    ),
  ]
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
    for (const ref of unresolvedRefsIn(decl, ctx)) {
      out.push({ selector: decl.selector, ref })
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
      const refs = new Set(ctxs.flatMap((ctx) => unresolvedRefsIn(decl, ctx)))
      for (const ref of refs) {
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

/**
 * 单个选择器分支在 env 下的具体值：根令牌被该分支可达且活跃的局部定义
 * 遮蔽；跨活跃条件分组仍先按重要性再取源序（媒体块内的 !important 不因
 * 条件在无条件后位定义之前而被覆盖）。保证无效的自定义属性进入 fallback。
 */
function valueScopeIn(decl: SheetDecl, ctx: WiringCtx): Map<string, string> {
  const scope = new Map(
    [...ctx.tokens].map(([name, value]) => [
      name,
      isGuaranteedInvalid(value, ':root') ? 'initial' : value,
    ]),
  )
  for (const [name, defs] of ctx.locals) {
    const usable = effectiveDefs(defs).filter(
      (def) =>
        conditionActive(def.condition, ctx.env) && scopeReaches([def], decl),
    )
    const winner = pickWinner(usable)
    if (winner)
      scope.set(
        name,
        isGuaranteedInvalid(winner.value, winner.selector)
          ? 'initial'
          : winner.value,
      )
  }
  return scope
}

/** 单分支展示色求值：与接线扫描使用同一作用域及主值/fallback 选择规则。 */
function displayValueIn(decl: SheetDecl, ctx: WiringCtx): string | null {
  return resolveDisplayValue(decl.value, valueScopeIn(decl, ctx))
}

/** 依赖图含回到自身的路径时该变量无效；fallback 内的依赖也参与 CSS 环检测。 */
function variableCycles(
  origin: string,
  name: string,
  scope: Map<string, string>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(name)) return false
  const next = new Set([...seen, name])
  return allVarRefs(scope.get(name) ?? '').some(
    (ref) => ref === origin || variableCycles(origin, ref, scope, next),
  )
}

/** 按最外层 var() 选择主值或 fallback，再递归消解嵌套函数；无可用值返回 null。 */
function resolveDisplayValue(
  value: string,
  scope: Map<string, string>,
  depth = 0,
): string | null {
  const start = value.indexOf('var(')
  if (start < 0) return value
  if (depth >= 32) return null
  const call = colorTokenOf(value.slice(start))
  const args = call.slice(4, -1)
  const comma = args.indexOf(',')
  const name = (comma < 0 ? args : args.slice(0, comma)).trim()
  const raw = scope.get(name)
  const primary =
    raw === undefined ||
    raw.trim().toLowerCase() === 'initial' ||
    variableCycles(name, name, scope)
      ? null
      : resolveDisplayValue(raw, scope, depth + 1)
  const replacement =
    primary ??
    (comma < 0
      ? null
      : resolveDisplayValue(args.slice(comma + 1).trim(), scope, depth + 1))
  if (replacement === null) return null
  const rest = resolveDisplayValue(
    value.slice(start + call.length),
    scope,
    depth + 1,
  )
  return rest === null ? null : value.slice(0, start) + replacement + rest
}

/** 语义用例共享的浅色基线环境（按需覆写单维度）。 */
const LIGHT_ENV: Env = {
  scheme: 'light',
  contrast: 'no-preference',
  transparency: 'no-preference',
  motion: 'no-reduce',
}

/** 真实样式表和夹具共用的类型扫描入口：逐活跃环境、逐选择器分支报告实际无效值。 */
function displayTypeErrors(root: postcss.Root, env: Env): string[] {
  const ctx: WiringCtx = {
    env,
    tokens: tokenValues(env),
    locals: localDefinitions(root),
  }
  return [...sheetDecls(root)].flatMap((decl) => {
    if (
      !isDisplayColorProp(decl.prop) ||
      !conditionActive(decl.condition, env)
    ) {
      return []
    }
    return decl.selector.split(',').flatMap((branch) => {
      const selector = branch.trim()
      const value = displayValueIn({ ...decl, selector }, ctx)
      return value !== null && !colorTypeOk(decl.prop, value)
        ? [`${selector} ${decl.prop}: ${value.trim()}`]
        : []
    })
  })
}

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
        tokens: tokenValues(LIGHT_ENV),
        locals: localDefinitions(root),
      }
      expect(displayValueIn(decl, ctx)).not.toBeNull()
      expect(displayTypeErrors(root, LIGHT_ENV)).toEqual([])
    },
  )
})

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

describe('令牌接线契约：全表扫描与注册表（issue #278）', () => {
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

  it('保证无效形态的定义在消费点判悬空（initial 恒无效；全局作用域 unset 退化同判）', () => {
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

  it('次级文本于全部承载面在 more 对比度下升档 ≥ 4.5:1（含 more × reduce 组合；基线为既有设计，§2.6）', () => {
    for (const [envName, env] of PAIR_ENVS.filter(
      ([, e]) => e.contrast === 'more',
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
 * 在给定根节点内按完整选择器找规则：须**唯一且无条件**（不处于任何
 * at-rule 内）——媒体块内同名规则会使生效值随环境分叉，违背黄金接线
 * 「恒值」前提；同名重复规则使文本序后位遮蔽先位，定位失真。选择器
 * 列表逐分支匹配：后续规则若在逗号分支中含目标选择器（如
 * `.other, .pw-dialog-danger { ... }`）仍能以同等特异性覆盖目标规则，
 * 也计入命中——不按整选择器字符串相等。sheet 仅用于错误信息；缺失/
 * 重复/条件化均抛错防测试静默空过。
 */
function ruleIn(
  root: postcss.Root,
  sheet: string,
  selector: string,
): postcss.Rule {
  const matches: postcss.Rule[] = []
  root.walkRules((rule) => {
    const branches = rule.selector.split(',').map((branch) => branch.trim())
    if (branches.includes(selector)) matches.push(rule)
  })
  if (matches.length === 0) throw new Error(`未找到规则 ${sheet} ${selector}`)
  if (matches.length > 1) {
    throw new Error(
      `${sheet} ${selector} 有 ${matches.length} 条包含该分支的规则，须唯一`,
    )
  }
  const rule = matches[0]!
  if (rule.parent?.type !== 'root') {
    throw new Error(`${sheet} ${selector} 处于 at-rule 内，须无条件规则`)
  }
  return rule
}

/** 真实组件样式表内按完整选择器找规则，见 ruleIn。 */
function ruleOf(sheet: string, selector: string): postcss.Rule {
  return ruleIn(sheets.get(sheet)!, sheet, selector)
}

/** 规则内该属性的生效值：属性名先按标准大小写归一，!important 声明优先于普通声明，同重要性取源序最后一条。 */
function declOf(rule: postcss.Rule, prop: string): string {
  const target = normalizeProp(prop)
  const decls = rule.nodes.filter(
    (node): node is postcss.Declaration =>
      node.type === 'decl' && normalizeProp(node.prop) === target,
  )
  if (decls.length === 0) throw new Error(`${rule.selector} 缺少 ${prop} 声明`)
  const important = decls.filter((decl) => decl.important)
  const winners = important.length > 0 ? important : decls
  return winners[winners.length - 1]!.value
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

  it('--on-danger 全部配对环境（含 more × reduce 组合）消解恒 #ffffff（视觉零变化；深色底 ≈2.8:1 为 #240 已记录边界，不重开）', () => {
    for (const [envName, env] of PAIR_ENVS) {
      expect(resolveChain('var(--on-danger)', tokenValues(env)), envName).toBe(
        '#ffffff',
      )
    }
  })
})

describe('遮罩语义契约（issue #278：遮罩只消费 alpha）', () => {
  it('全部组件样式表发现的 linear-gradient 遮罩首末色标全透明、内部全不透明（语义断言，不锚定出现条数）', () => {
    for (const [sheet, root] of sheets) {
      if (sheet === TOKEN_SHEET) continue
      for (const decl of sheetDecls(root)) {
        if (!decl.prop.endsWith('mask-image')) continue
        if (!/^linear-gradient\(/i.test(decl.value.trim())) {
          throw new Error(`${sheet} ${decl.prop} 非 linear-gradient，未建模`)
        }
        const alphas = maskStopAlphas(decl.value)
        const label = `${sheet} ${decl.selector} ${decl.prop}`
        expect(alphas.length, `${label} 色标数`).toBeGreaterThanOrEqual(3)
        expect(alphas[0], `${label} 顶边全透明`).toBe(0)
        expect(alphas[alphas.length - 1], `${label} 底边全透明`).toBe(0)
        for (const [i, alpha] of alphas.slice(1, -1).entries()) {
          expect(alpha, `${label} 内部色标 ${i} 须全不透明`).toBe(1)
        }
      }
    }
  })

  it('遮罩 alpha 剖析机器（夹具钉住非空覆盖）：合规渐隐为真，内部半透明/端点不透明为假', () => {
    expect(
      maskStopAlphas(
        'linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 14px), transparent 100%)',
      ),
    ).toEqual([0, 1, 1, 0])
    expect(
      maskStopAlphas(
        'linear-gradient(to bottom, transparent 0, rgba(0, 0, 0, 0.5) 12px, transparent 100%)',
      ),
      '内部色标半透明即不合规',
    ).toEqual([0, 0.5, 0])
    expect(
      maskStopAlphas('linear-gradient(to bottom, #000 0, transparent 100%)'),
      '首色标不透明即不合规',
    ).toEqual([1, 0])
  })
})
