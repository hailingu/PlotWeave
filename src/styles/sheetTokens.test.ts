/**
 * 全表 CSS 令牌契约（issue #278）：真实 glob 的发现、展示色结构/例外、接线、
 * 配对、危险动作黄金接线与遮罩 alpha。语义取值复用 sheetTokensEngine。
 * 当前支持/拒绝/保留边界与唯一问题族矩阵见 docs/css-token-contract.md；
 * 分轮记录仅在 Git 历史保留，不在测试头注另维护一套范围。
 * F6 产品边界：#240 恒白危险前景及深色约 2.8:1 沿用既有决策；
 * #262 品牌配对、#265 悬空引用仍由具名注册表挂账；box-shadow 不禁字面色。
 * F4 仅静态 linear-gradient 遮罩：动态 currentColor、未知色标与图像入口显式拒绝。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import {
  colorTokenOf,
  completeColorAtom,
  hasColorLiteral,
  imageKind,
  isNamedColor,
} from './cssColorContract'
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
      (['no-preference', 'reduce'] as const).map((motion): [string, Env] => [
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
  if (isNamedColor(value)) return 1
  throw new Error(`MASK_STOP_UNMODELED: ${value}`)
}

/** linear-gradient 遮罩的色标 alpha 序列（方向段跳过）。 */
function maskStopAlphas(value: string): number[] {
  const trimmed = value.trim()
  const inner = trimmed.slice(
    trimmed.indexOf('(') + 1,
    trimmed.lastIndexOf(')'),
  )
  return splitTopLevel(inner)
    .map((part) => part.trim())
    .filter((part) => !/^(-?[\d.]+(deg|turn|rad|grad)|to\s)/i.test(part))
    .map((part) => stopAlpha(colorTokenOf(part)))
}

/** 判定整个值恰为一个括号平衡的 linear-gradient，不接受尾随内容或第二层。 */
function isCompleteLinearGradient(value: string): boolean {
  const trimmed = value.trim()
  if (!/^linear-gradient\(/i.test(trimmed)) return false
  try {
    return colorTokenOf(trimmed) === trimmed
  } catch {
    return false
  }
}

/** 承载遮罩图像的属性（长形、简写与边框遮罩）；尺寸/模式等长形不承载图像。 */
function isMaskImageProp(prop: string): boolean {
  return /^(-webkit-)?mask(-image|-border(-source)?|-box-image(-source)?)?$/i.test(
    prop,
  )
}

/** 仅 mask-image 长形的 linear-gradient 已建模：首末色标全透明、内部全不透明；其余形态失败。 */
function expectMaskFade(
  label: string,
  decl: { prop: string; value: string },
): void {
  if (
    !/mask-image$/i.test(decl.prop) ||
    !isCompleteLinearGradient(decl.value)
  ) {
    throw new Error(`MASK_IMAGE_UNMODELED: ${label}`)
  }
  const alphas = maskStopAlphas(decl.value)
  expect(alphas.length, `${label} 色标数`).toBeGreaterThanOrEqual(3)
  expect(alphas[0], `${label} 顶边全透明`).toBe(0)
  expect(alphas[alphas.length - 1], `${label} 底边全透明`).toBe(0)
  for (const [i, alpha] of alphas.slice(1, -1).entries()) {
    expect(alpha, `${label} 内部色标 ${i} 须全不透明`).toBe(1)
  }
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
})

describe('F6 可达消费闭包与例外反向校验', () => {
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
        { scheme, contrast, transparency, motion: 'no-preference' },
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

/** 各环境的单个完整颜色成分复用类型识别；成分提取不要求数值 RGBA 转换。 */
function isColorOnlyShorthand(value: string): boolean {
  return PAIR_ENVS.every(([, env]) =>
    completeColorAtom(resolveChain(value, tokenValues(env))),
  )
}

/** 黄金接线只投影单层颜色/图像；未知成分、多层和重复成分显式失败，不部分提取。 */
function shorthandPaint(value: string): { color: string; image: string } {
  const parts = postcss.list.space(value)
  const colors = parts.filter(isColorOnlyShorthand)
  const images = parts.filter(
    (part) => /^none$/i.test(part) || imageKind(part) !== null,
  )
  if (
    parts.length === 0 ||
    colors.length > 1 ||
    images.length > 1 ||
    parts.length !== colors.length + images.length
  ) {
    throw new Error(`TOKEN_BACKGROUND_SHORTHAND_UNMODELED: ${value}`)
  }
  return { color: colors[0] ?? 'transparent', image: images[0] ?? 'none' }
}

/** 规则内底色绘制的有效颜色与图像成分：background 简写展开到两条长形，各成分独立层叠。 */
function backgroundPaint(rule: postcss.Rule): { color: string; image: string } {
  const colorDecl = winningDecl(rule, ['background', 'background-color'])
  const color =
    normalizeProp(colorDecl.prop) === 'background'
      ? shorthandPaint(colorDecl.value).color
      : colorDecl.value
  const hasImage = rule.nodes.some(
    (node) =>
      node.type === 'decl' &&
      ['background', 'background-image'].includes(normalizeProp(node.prop)),
  )
  if (!hasImage) return { color, image: 'none' }
  const image = winningDecl(rule, ['background', 'background-image'])
  return {
    color,
    image:
      normalizeProp(image.prop) === 'background'
        ? shorthandPaint(image.value).image
        : image.value,
  }
}

const DANGER_PAINT = { color: 'var(--danger)', image: 'none' }

describe('危险动作前景接线（#240 决策补齐，issue #278）', () => {
  it('四处危险前景经 --on-danger、底经 --danger（字面接线，不残留 #fff）', () => {
    for (const { sheet, selector } of DANGER_RULES) {
      const rule = ruleOf(sheet, selector)
      expect(declOf(rule, 'color'), `${sheet} ${selector} color`).toBe(
        'var(--on-danger)',
      )
      expect(backgroundPaint(rule), `${sheet} ${selector} background`).toEqual(
        DANGER_PAINT,
      )
    }
  })

  it('危险底色按颜色与图像成分各自层叠：简写展开到两条长形，长形只覆盖其自身成分', () => {
    const paint = (css: string): { color: string; image: string } =>
      backgroundPaint(postcss.parse(css).first as postcss.Rule)
    expect(
      paint('.d { background-color: #000; background: var(--danger) }'),
      '简写重置先位长形',
    ).toEqual(DANGER_PAINT)
    expect(
      paint(
        '.d { background: var(--danger); BACKGROUND-COLOR: var(--surface-card) }',
      ),
    ).toEqual({ color: 'var(--surface-card)', image: 'none' })
    expect(
      paint(
        '.d { background-image: linear-gradient(#000, #000) !important; background: var(--danger) }',
      ),
    ).toEqual({
      color: 'var(--danger)',
      image: 'linear-gradient(#000, #000)',
    })
    expect(
      paint(
        '.d { background: var(--danger) !important; background-color: var(--surface-card) }',
      ),
    ).toEqual(DANGER_PAINT)
    expect(
      paint('.d { background: var(--danger); background-image: none }'),
      '后位图像长形不改变颜色成分',
    ).toEqual(DANGER_PAINT)
    expect(
      paint('.d { background: var(--danger); background-image: url(a.png) }'),
    ).toEqual({ color: 'var(--danger)', image: 'url(a.png)' })
    expect(paint('.d { background-color: var(--danger) }')).toEqual(
      DANGER_PAINT,
    )
    expect(
      paint(
        '.d { background: var(--surface-card); background-color: var(--danger) }',
      ),
      '纯色简写只贡献颜色层',
    ).toEqual(DANGER_PAINT)
    expect(
      paint(
        '.d { background: url(a.png) var(--danger); background-color: var(--danger) }',
      ),
      '含图像的简写不被当作纯色层',
    ).toEqual({ color: 'var(--danger)', image: 'url(a.png)' })
  })

  it('--on-danger 全部配对环境（含 more × reduce 组合）消解恒 #ffffff（视觉零变化；深色底 ≈2.8:1 为 #240 已记录边界，不重开）', () => {
    for (const [envName, env] of PAIR_ENVS) {
      expect(resolveChain('var(--on-danger)', tokenValues(env)), envName).toBe(
        '#ffffff',
      )
    }
  })
})

describe('F2-c 含图像简写的成分提取与相邻长形覆盖', () => {
  it.each([
    'background: url(a.png) var(--danger); background-image: none',
    'background: var(--danger) url(a.png); BACKGROUND-IMAGE: none',
    'background-image: none !important; background: url(a.png) var(--danger)',
    'background: linear-gradient(#000, #000) var(--danger); background-image: none',
    'background: url("a b.png") var(--danger); background-image: none',
  ])('图像被长形重置后保留危险颜色：%s', (decls) => {
    const rule = postcss.parse(`.d { ${decls} }`).first as postcss.Rule
    expect(backgroundPaint(rule)).toEqual(DANGER_PAINT)
  })

  it.each([
    ['background: var(--danger)', DANGER_PAINT],
    ['background: none', { color: 'transparent', image: 'none' }],
    [
      'background-color: var(--danger); background: url(a.png)',
      { color: 'transparent', image: 'url(a.png)' },
    ],
    [
      'background: url(a.png) var(--danger); background-color: var(--surface-card)',
      { color: 'var(--surface-card)', image: 'url(a.png)' },
    ],
    [
      'background: url(a.png) var(--danger) !important; background-image: none',
      { color: 'var(--danger)', image: 'url(a.png)' },
    ],
    [
      'background-image: none; background: url(a.png) var(--danger)',
      { color: 'var(--danger)', image: 'url(a.png)' },
    ],
    [
      'background: url(a.png) var(--danger); background: var(--danger)',
      DANGER_PAINT,
    ],
  ])('未重置或其他成分取胜时按各自长形结果判断：%s', (decls, expected) => {
    const rule = postcss.parse(`.d { ${decls} }`).first as postcss.Rule
    expect(backgroundPaint(rule)).toEqual(expected)
  })

  it.each(['url(a.png) var(--danger) unknown', 'url(a.png), var(--danger)'])(
    '域外黄金简写不能被部分提取成合法配对：%s',
    (value) => {
      const rule = postcss.parse(
        `.d { background: ${value}; background-image: none; }`,
      ).first as postcss.Rule
      expect(() => backgroundPaint(rule)).toThrow(
        /TOKEN_BACKGROUND_SHORTHAND_UNMODELED/,
      )
    },
  )
})

describe('F2-c 颜色成分识别与颜色长形覆盖', () => {
  it.each([
    'transparent',
    'TRANSPARENT',
    'rebeccapurple',
    'currentColor',
    'rgb(0 0 0 / 0)',
    'hsl(0 0% 0%)',
    '#0000',
    'var(--text-primary)',
  ])('颜色 %s 被长形覆盖后保留 none 图像', (color) => {
    const rule = postcss.parse(
      `.d { background: ${color}; background-color: var(--danger); }`,
    ).first as postcss.Rule
    expect(backgroundPaint(rule)).toEqual(DANGER_PAINT)
  })
})

describe('F2-c 透明色简写的相邻转换与拒绝边界', () => {
  it.each([
    [
      'background-color: var(--danger) !important; background: transparent',
      DANGER_PAINT,
    ],
    [
      'background-color: var(--danger); background: transparent',
      { color: 'transparent', image: 'none' },
    ],
    [
      'background: transparent !important; background-color: var(--danger)',
      { color: 'transparent', image: 'none' },
    ],
    [
      'background: transparent url(a.png); background-color: var(--danger)',
      { color: 'var(--danger)', image: 'url(a.png)' },
    ],
    [
      'background: url(a.png) transparent; background-image: none',
      { color: 'transparent', image: 'none' },
    ],
    [
      'background: transparent; background-image: url(a.png)',
      { color: 'transparent', image: 'url(a.png)' },
    ],
  ])('相邻顺序、重要性与图像保留：%s', (decls, expected) => {
    const rule = postcss.parse(`.d { ${decls} }`).first as postcss.Rule
    expect(backgroundPaint(rule)).toEqual(expected)
  })

  it.each([
    'transparent-junk',
    'transparent currentColor',
    'transparent inherit',
    'CanvasText',
  ])('颜色长形不能掩盖域外/重复成分：%s', (value) => {
    const rule = postcss.parse(
      `.d { background: ${value}; background-color: var(--danger); }`,
    ).first as postcss.Rule
    expect(() => backgroundPaint(rule)).toThrow(
      /TOKEN_BACKGROUND_SHORTHAND_UNMODELED/,
    )
  })
})

describe('遮罩语义契约（issue #278：遮罩只消费 alpha）', () => {
  it('全部组件样式表发现的 linear-gradient 遮罩首末色标全透明、内部全不透明（语义断言，不锚定出现条数）', () => {
    for (const [sheet, root] of sheets) {
      if (sheet === TOKEN_SHEET) continue
      for (const decl of sheetDecls(root)) {
        if (!isMaskImageProp(decl.prop)) continue
        expectMaskFade(`${sheet} ${decl.selector} ${decl.prop}`, decl)
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

  it.each([
    'mask',
    '-webkit-mask',
    'mask-border',
    'mask-border-source',
    '-webkit-mask-box-image',
    '-webkit-mask-box-image-source',
  ])(
    '承载遮罩图像的 %s 进入契约且未建模即失败（review 5286221158）',
    (prop) => {
      expect(isMaskImageProp(prop)).toBe(true)
      expect(() =>
        expectMaskFade(prop, {
          prop,
          value: 'linear-gradient(#000, #000)',
        }),
      ).toThrow(/MASK_IMAGE_UNMODELED/)
    },
  )

  it.each([
    'mask-size',
    'mask-mode',
    'mask-type',
    'mask-border-width',
    '-webkit-mask-box-image-slice',
  ])('不承载图像的 %s 不进入遮罩契约', (prop) =>
    expect(isMaskImageProp(prop)).toBe(false),
  )
})

describe('F4 遮罩 alpha：只接受可确定透明度的静态色标', () => {
  it.each(['currentColor', 'CURRENTCOLOR', 'not-a-color', 'CanvasText'])(
    'F4-a 内部色标 %s 不能被当作不透明常量',
    (stop) => {
      const root = postcss.parse(
        `@media (prefers-color-scheme: dark) { .a { color: transparent; -webkit-mask-image: linear-gradient(transparent, ${stop}, transparent); } }`,
      )
      const decl = [...sheetDecls(root)].find((item) =>
        isMaskImageProp(item.prop),
      )!
      expect(() => expectMaskFade('F4-a', decl)).toThrow(/MASK_STOP_UNMODELED/)
    },
  )

  it.each([
    'black',
    'rebeccapurple',
    '#000',
    'rgb(0, 0, 0)',
    'rgb(0 0 0 / 100%)',
  ])('F4-b 已知静态不透明色标 %s 保持通过', (stop) =>
    expect(() =>
      expectMaskFade('F4-b', {
        prop: 'mask-image',
        value: `linear-gradient(transparent, ${stop}, transparent)`,
      }),
    ).not.toThrow(),
  )

  it('F4-b 静态半透明内部色标仍违反渐隐约束', () => {
    expect(() =>
      expectMaskFade('F4-b', {
        prop: 'mask-image',
        value: 'linear-gradient(transparent, #0008, transparent)',
      }),
    ).toThrow(/须全不透明/)
  })

  it.each([
    'linear-gradient(transparent, black, transparent) junk',
    'linear-gradient(transparent, black, transparent), none',
    'linear-gradient(transparent, black, transparent), linear-gradient(transparent, black, transparent)',
    'linear-gradient(transparent, black, transparent))',
    'linear-gradient(transparent, black, transparent',
  ])('F4-b 拒绝不完整、尾随或多层遮罩：%s', (value) => {
    expect(() => expectMaskFade('F4-b', { prop: 'mask-image', value })).toThrow(
      /MASK_IMAGE_UNMODELED/,
    )
  })

  it('F4-b 单层完整渐变保留大小写、空白及嵌套颜色函数', () => {
    expect(() =>
      expectMaskFade('F4-b', {
        prop: '-webkit-mask-image',
        value:
          '  LINEAR-GRADIENT(transparent, rgb(0 0 0 / 100%), transparent)  ',
      }),
    ).not.toThrow()
  })
})
