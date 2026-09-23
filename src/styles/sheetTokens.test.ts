/**
 * 全部组件样式表对令牌体系的遵循契约（issue #278）。
 *
 * 契约来源：docs/ui-design.md 原则 2「语义色令牌，不硬编码颜色；文本与
 * 背景对比度 ≥ 4.5:1」、§2.1「组件只引用语义令牌」与 §2.6 三无障碍变体。
 * 与 issue #107（nodes.css）/ #240（panels.css）/ #261（home.css 菜单钮）
 * 的分表契约同一验证口径（postcss 解析真实样式表），本文件把结构、接线、
 * 配对三类断言推广到 src 下全部组件样式表：按 glob 自动发现，新增样式表
 * 无需登记即进入全部契约（不维护文件布局清单，不要求每张表包含展示色），
 * 消除「布线不全」这一 D33 根因。CSS 层叠/取值引擎（媒体环境求值、声明
 * 遍历、局部自定义属性解析、悬空引用扫描、类型校验）抽至
 * `sheetTokensEngine.ts`，与语义/夹具测试 `sheetTokensSemantics.test.ts`
 * 共用同一实现；本文件保留对真实样式表的扫描断言（发现/结构/接线/配对/
 * 黄金接线/遮罩），控制在测试文件行数上限内（语义/夹具用例矩阵行与探测
 * 器的单元用例见 sheetTokensSemantics.test.ts 头注）。
 *
 * 范围界定（issue #278 验收标准）：
 * - 结构断言覆盖展示色属性（前景 color 与全部标准 `-color` 长形——含
 *   text-emphasis-color、scrollbar-color 及厂商前缀长形，按结构式分类；背景与
 *   background-image 长形、轮廓、text-emphasis/text-shadow、SVG fill/stroke，以及 border 全部简写/长形——总体、
 *   四向、逻辑方向与 border-image(-source) 长形，按结构式分类而非枚举；
 *   标准属性名先按 ASCII 大小写不敏感归一再分类，自定义属性名大
 *   小写保持原样）；字面色含 hex、大小写不敏感的颜色函数与 CSS 具名色；
 *   transparent（仅 alpha=0 无色相）与 currentcolor（继承而非字面）不计。
 *   box-shadow 是层级投影非主题展示色、mask-image 只消费 alpha 通道（遮罩
 *   语义另断言），两者不在字面色禁用范围。
 *   经展示色属性传递消费的局部自定义属性同样受禁：`.b { --fg: #fff; color:
 *   var(--fg) }` 不得绕过契约（消费关系沿局部属性值链传递闭包计算，只跟随
 *   选择器可达展示消费分支的定义——不可达的同名局部复用不入契约；仅被
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
 *   遮盖，且该重要性优先规则跨活跃条件分组仍然成立。跨选择器特异性未建模。
 *   已支持的简单后代/子代选择器先选最近定义元素：自身指定值先于祖先继承值，
 *   然后仅在同元素候选中比较重要性/源序；不同逗号分支与媒体环境独立选择。
 *   根令牌（tokens.css :root）同名声明同样先按重要性再按源序取胜，与局部
 *   自定义属性同一规则。initial 与文档根 :root/html 的 unset 按保证无效值处理；
 *   非根 unset、inherit、revert/revert-layer 的自定义属性胜出值明确拒绝，
 *   报 TOKEN_CSS_WIDE_UNMODELED，不能当作消费属性的合法关键字透传。
 *   真实表带 from 来源，组件全局自定义属性报 TOKEN_GLOBAL_OUTSIDE_SOURCE，
 *   即使本表没有消费者也不能覆盖唯一定义源 tokens.css；局部定义仍可遮蔽。
 *   `@property` 注册总是全局生效：组件表或无来源夹具中报
 *   TOKEN_GLOBAL_OUTSIDE_SOURCE，令牌源内尚未建模报 TOKEN_ROOT_AT_RULE_UNMODELED。
 *   根令牌处于未知外层 at-rule 或根规则内嵌 at-rule 时明确报 TOKEN_ROOT_AT_RULE_UNMODELED，
 *   不再静默跳过该定义入口；不含根令牌的其他上下文不受此限制。选择器列表的
 *   `:root` 分支按根规则取值，其他可能命中文档根的选择器上的定义报
 *   TOKEN_ROOT_SELECTOR_UNMODELED。
 *   组件规则内嵌规则/at-rule 报 TOKEN_SHEET_NESTING_UNMODELED；非 media
 *   上下文中的局部定义报 TOKEN_LOCAL_AT_RULE_UNMODELED，不当作恒活跃定义。
 *   字面色检测跳过 URL/引号字符串的内容，仍检查外部渐变与 fallback 中的颜色。
 *   变量依赖、悬空检查及取值同样跳过这些不透明内容，字面 var() 不构成依赖或替换点；
 *   实际取值保留原内容，真实 fallback 引用仍参与环检测，见 sheetTokenReferences.test.ts。
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
 *   声明覆盖；危险底色把 background 与 background-color/background-image
 *   同组取胜，后位或重要长形覆盖简写即点名；目标规则须唯一且无条件——媒体块内同名规则会使生效值随环境
 *   分叉，违背 #240 恒白决策的接线前提。唯一性判定按选择器列表逐分支：后续
 *   规则若在逗号分支中含目标选择器（如 `.other, .pw-dialog-danger { ... }`）仍能
 *   以同等特异性覆盖，也计入命中，不按整选择器字符串相等。
 * - 开放缺陷以跟踪单号入表：#262（品牌底固定白字 ×2）、#265（悬空
 *   --fill-tertiary ×1）；其修复落地时注册表同步收缩。
 * - 不重开 #240 危险色决策：--on-danger 恒白，深色底 ≈2.8:1 为已记录
 *   已知边界，不做对比度断言；本单只把该决策接线到 editor/nodes-settings
 *   四处字面 #fff（令牌恒值 #ffffff，视觉零变化）。
 *
 * Key State And Invariant Matrix（外观 × 对比度 × 交互态 × 布线；语义/
 * 夹具用例矩阵行见 sheetTokensSemantics.test.ts 头注）：
 * | 状态/前提 | 动作/过渡 | 可观测结果 | 不变量 | 验证 |
 * | --- | --- | --- | --- | --- |
 * | 新增组件样式表（包括仅布局/动画或空表） | glob 发现 | 自动进入全部契约，无登记清单或展示色条数要求 | 布线不全不可悄然发生 | 发现探针与无展示色夹具 |
 * | 新增展示色字面声明（hex/大小写不敏感函数色/具名色；含 fill/stroke、background-image、border-image(-source) 与 border 全部简写/长形） | 结构扫描 | 非注册表项即失败（点名表/选择器/声明） | 展示色必须经 tokens.css 或具名例外 | 结构测试 |
 * | 局部自定义属性被展示色属性（传递）消费且值含字面色 | 结构扫描 | 按违例点名（同注册表豁免）；不可达的同名局部复用不点名 | 字面色不得经局部变量别名进入展示位；闭包与接线同一可达性 | 结构测试 |
 * | 展示色引用解析为不相容值（尺寸/裸数值叶子；不接受图像的属性上的渐变/URL） | 逐环境校验属性 | 按违例点名；合法背景图像及 SVG URL 通过 | 图像必须由支持该语法的属性消费 | 结构测试 |
 * | 注册表项同属性换写其他字面色 / 新增第二条同值字面声明 / 超出已审计条数 | 结构扫描 | 按新违例点名（豁免绑定到值与条数） | 例外不覆盖未审计的值或条数 | 结构测试 |
 * | 注册表项对应声明被修复、换值或条数变动 | 结构反向校验 | 表项失配即失败 | 例外表不藏已修复项 | 结构测试 |
 * | 引用未定义 var()、令牌/局部定义值链引用缺失名（传递）、或定义为保证无效值（initial / 文档根 unset） | 接线扫描 | 失败点名（D38 类悬空引用） | 无失效 var 静默回落 | 接线测试 |
 * | 根令牌（tokens.css :root）同名声明含 !important | 令牌取值 | 重要声明优先于普通声明，无论源序 | 根令牌与局部自定义属性同一重要性规则 | 接线测试（间接经真实 tokens.css 解析），单元用例见 sheetTokensSemantics.test.ts |
 * | 已豁免悬空引用换属性承载或新增第二条声明 | 接线扫描（属性 + 条数比对） | 按新违例点名 | 接线豁免不扩张已知缺陷 | 接线测试 |
 * | 浅/深 × 基线/more × 基线/降透明度（8 环境） | 配对矩阵 | primary 全环境 ≥4.5、secondary more 升档 ≥4.5（§2.6） | 原则 2 按令牌配对成立（含 reduce-transparency 实色材质） | 配对测试 |
 * | 悬停态换填充 | 配对矩阵 | text-primary 于 fill-quaternary 承载面 ≥4.5 | hover 配对按既有契约 | 配对测试 |
 * | 危险动作 hover/确认 | 黄金接线（规则唯一无条件——包括逗号分支内的同分支覆盖；属性名归一；生效值按重要性再取源序最后一条；底色与背景长形同组取胜） | 前景全部配对环境恒 #ffffff（#240 决策） | 危险前景经 --on-danger，生效值不随环境分叉且不被普通声明/大小写变体/同等特异性分支/背景长形逆转 | 黄金测试 |
 * | 遮罩渐变 | alpha 剖析 | 首末色标全透明、内部全不透明 | 遮罩只消费 alpha | 遮罩测试 |
 *
 * 未覆盖维度：真实 WebView 像素实测未运行；品牌底两处配对归 #262、悬空
 * 变量归 #265 跟踪；accent-alt 焦点描边/青 wash（.pw-ai-ctx-toggle.on）的
 * 非文本 3:1 未断言——无既有决策，不在本单开新前沿（PR 披露）。
 * 值解析仍为静态子集，非完整 CSS 文法/层叠引擎；复杂选择器及跨选择器
 * 特异性与颜色函数内部参数未建模。审查处理记录见
 * docs/reviews/pr-288-review-5280542926.md、pr-288-review-5280837519.md 与
 * pr-288-review-5285788301.md；
 * 纯值校验由 cssColorContract.ts 负责。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import { colorTokenOf, hasColorLiteral } from './cssColorContract'
import {
  allVarRefs,
  declOf,
  displayTypeErrors,
  isDisplayColorProp,
  localDefinitions,
  normalizeProp,
  resolveChain,
  ruleIn,
  scopeReaches,
  sheetDecls,
  tokenValues,
  TOKEN_SHEET,
  unresolvedRefsIn,
  winningDecl,
  type Env,
  type SheetDecl,
} from './sheetTokensEngine'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path: string): string =>
  readFileSync(join(repoRoot, path), 'utf8')

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
  discoverCssSheets().map((path) => [
    path,
    postcss.parse(read(path), { from: join(repoRoot, path) }),
  ]),
)

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

describe('样式表发现（issue #278：契约覆盖全部组件样式表）', () => {
  it('发现集含令牌定义源与组件表，新表自动进入扫描且不要求展示色声明数量', () => {
    expect(sheets.has(TOKEN_SHEET)).toBe(true)
    const components = [...sheets].filter(([sheet]) => sheet !== TOKEN_SHEET)
    expect(components.length).toBeGreaterThan(0)
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

  it('经展示色传递消费的局部自定义属性不引入字面色（消费闭包含间接消费）', () => {
    const root = postcss.parse(
      '.a { --fg: #fff; color: var(--fg); }\n' +
        '.b { --mid: var(--fg); background: var(--mid); }\n' +
        '.c { --shadow: 0 2px 8px rgba(0, 0, 0, 0.2); box-shadow: var(--shadow); }\n' +
        '.d { --unused: #fff; }',
    )
    const consumed = displayConsumedDefs(root)
    expect(consumed.has(localKey('.a', '', '--fg', '#fff')), '直接消费').toBe(
      true,
    )
    expect(
      consumed.has(localKey('.b', '', '--mid', 'var(--fg)')),
      '间接消费（经 --mid 值链）',
    ).toBe(true)
    expect(consumed.size, '仅被 box-shadow 消费或未被消费的不入契约').toBe(2)
  })

  it('消费闭包只跟随可达定义：不可达的同名局部复用不入展示色契约', () => {
    const dark = '@media (prefers-color-scheme: dark);'
    const root = postcss.parse(
      '.a { color: var(--text-primary) }\n' +
        '.b { --text-primary: rgba(0, 0, 0, 0.2); box-shadow: 0 0 4px var(--text-primary) }\n' +
        '.p { --fg: #fff; --mid: var(--fg); }\n' +
        '.p .x { background: var(--mid) }\n' +
        '@media (prefers-color-scheme: dark) { .p { --fg: #000; } }\n' +
        '.q { --fg: red; }',
    )
    expect([...displayConsumedDefs(root)].sort()).toEqual(
      [
        localKey('.p', '', '--fg', '#fff'),
        localKey('.p', '', '--mid', 'var(--fg)'),
        localKey('.p', dark, '--fg', '#000'),
      ].sort(),
    )
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

/** 局部定义身份：选择器 + 条件 + 属性 + 值，与 sheetDecls 枚举的声明对齐。 */
function localKey(
  selector: string,
  condition: string,
  prop: string,
  value: string,
): string {
  return `${selector}|${condition}|${prop}|${value}`
}

/**
 * 经展示色属性（沿局部属性值链传递）消费的局部定义身份集合：只跟随选择器
 * 可达消费分支的定义（任一环境条件），与接线/类型扫描同一可达性。仅被
 * 非展示属性（如 box-shadow）消费或无法到达展示消费点的同名定义不在契约内。
 */
function displayConsumedDefs(root: postcss.Root): Set<string> {
  const locals = localDefinitions(root)
  const consumed = new Set<string>()
  const seen = new Set<string>()
  const queue = [...sheetDecls(root)]
    .filter((decl) => isDisplayColorProp(decl.prop))
    .flatMap((decl) =>
      decl.selector.split(',').flatMap((branch) =>
        allVarRefs(decl.value).map((name) => ({
          selector: branch.trim(),
          name,
        })),
      ),
    )
  while (queue.length > 0) {
    const { selector, name } = queue.pop()!
    if (seen.has(`${selector}#${name}`)) continue
    seen.add(`${selector}#${name}`)
    for (const def of locals.get(name) ?? []) {
      if (!scopeReaches([def], { selector })) continue
      consumed.add(localKey(def.selector, def.condition, name, def.value))
      queue.push(
        ...allVarRefs(def.value).map((ref) => ({ selector, name: ref })),
      )
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
    const consumed = displayConsumedDefs(root)
    for (const decl of sheetDecls(root)) {
      if (isDisplayColorProp(decl.prop) && hasColorLiteral(decl.value)) {
        bump(sheet, decl)
      } else if (
        decl.prop.startsWith('--') &&
        consumed.has(
          localKey(decl.selector, decl.condition, decl.prop, decl.value),
        ) &&
        hasColorLiteral(decl.value)
      ) {
        bump(sheet, decl)
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

/** 真实组件样式表内按完整选择器找规则，见 sheetTokensEngine 的 ruleIn。 */
function ruleOf(sheet: string, selector: string): postcss.Rule {
  return ruleIn(sheets.get(sheet)!, sheet, selector)
}

/** 背景简写与可覆盖其绘制结果的长形同组取胜。 */
const BACKGROUND_PAINT_PROPS = [
  'background',
  'background-color',
  'background-image',
] as const

/** 规则内底色绘制的实际胜出声明，形如 `background: var(--danger)`。 */
function backgroundPaint(rule: postcss.Rule): string {
  const decl = winningDecl(rule, BACKGROUND_PAINT_PROPS)
  return `${normalizeProp(decl.prop)}: ${decl.value}`
}

describe('危险动作前景接线（#240 决策补齐，issue #278）', () => {
  it('四处危险前景经 --on-danger、底经 --danger（字面接线，不残留 #fff）', () => {
    for (const { sheet, selector } of DANGER_RULES) {
      const rule = ruleOf(sheet, selector)
      expect(declOf(rule, 'color'), `${sheet} ${selector} color`).toBe(
        'var(--on-danger)',
      )
      expect(backgroundPaint(rule), `${sheet} ${selector} background`).toBe(
        'background: var(--danger)',
      )
    }
  })

  it('危险底色按背景简写与长形的实际胜出声明判定：后位或重要长形覆盖即点名', () => {
    const paint = (css: string): string =>
      backgroundPaint(postcss.parse(css).first as postcss.Rule)
    expect(
      paint('.d { background-color: #000; background: var(--danger) }'),
      '简写重置先位长形',
    ).toBe('background: var(--danger)')
    expect(
      paint(
        '.d { background: var(--danger); BACKGROUND-COLOR: var(--surface-card) }',
      ),
    ).toBe('background-color: var(--surface-card)')
    expect(
      paint(
        '.d { background-image: linear-gradient(#000, #000) !important; background: var(--danger) }',
      ),
    ).toBe('background-image: linear-gradient(#000, #000)')
    expect(
      paint(
        '.d { background: var(--danger) !important; background-color: var(--surface-card) }',
      ),
    ).toBe('background: var(--danger)')
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
