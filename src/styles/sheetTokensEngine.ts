/**
 * 令牌契约的 CSS 层叠/取值引擎（issue #278）：媒体环境求值、声明遍历、
 * 局部自定义属性解析（含重要性/条件分组取胜）、悬空引用扫描、展示色类型
 * 校验、黄金规则生效值取值。供全表契约测试（真实样式表扫描，
 * sheetTokens.test.ts）与语义/夹具测试（sheetTokensSemantics.test.ts、
 * sheetTokenReferences.test.ts）
 * 共用，避免两处逻辑分叉。纯值校验（字面色探测、颜色成分/文法）由
 * cssColorContract.ts 负责。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { colorTokenOf, colorTypeOk } from './cssColorContract'
import { maskCssOpaque } from './cssValueSyntax'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

/** 令牌定义源：作为唯一定义方排除在组件样式表契约外。 */
export const TOKEN_SHEET = 'src/styles/tokens.css'

/** 样式契约建模的四个用户偏好维度，决定媒体声明是否参与当前取值。 */
export type Env = {
  scheme: 'light' | 'dark'
  contrast: 'no-preference' | 'more'
  transparency: 'no-preference' | 'reduce'
  motion: 'no-preference' | 'reduce'
}

/** 语义用例共享的浅色基线环境（按需覆写单维度）。 */
export const LIGHT_ENV: Env = {
  scheme: 'light',
  contrast: 'no-preference',
  transparency: 'no-preference',
  motion: 'no-preference',
}

const MEDIA_FEATURES = {
  'prefers-color-scheme': 'scheme',
  'prefers-contrast': 'contrast',
  'prefers-reduced-transparency': 'transparency',
  'prefers-reduced-motion': 'motion',
} as const

/** 各维度已建模的 CSS 关键字；域外取值（含合法的 `less` 等）不能静默失活。 */
const MEDIA_VALUES: Record<keyof Env, readonly string[]> = {
  scheme: ['light', 'dark'],
  contrast: ['no-preference', 'more'],
  transparency: ['no-preference', 'reduce'],
  motion: ['no-preference', 'reduce'],
}

const MEDIA_FEATURE_PATTERN = /^\(([\w-]+):\s*([\w-]+)\)$/

/** 单个 `(特性: 值)` 在 env 下的真伪；未建模特性或取值明确失败。 */
function featureMatches(raw: string, env: Env): boolean {
  const feature = MEDIA_FEATURE_PATTERN.exec(raw.trim())
  const key = feature?.[1] as keyof typeof MEDIA_FEATURES | undefined
  if (!feature || !key || !(key in MEDIA_FEATURES)) {
    throw new Error(`令牌模型未建模的 media 特性: ${raw.trim()}`)
  }
  const field = MEDIA_FEATURES[key]
  if (!MEDIA_VALUES[field].includes(feature[2]!)) {
    throw new Error(`TOKEN_MEDIA_VALUE_UNMODELED: ${raw.trim()}`)
  }
  return env[field] === feature[2]
}

/** 求 @media 前置值真伪（逗号组相或、and 相与；嵌套块由调用方递归）。 */
function mediaMatches(prelude: string, env: Env): boolean {
  return prelude
    .toLowerCase()
    .split(',')
    .some((group) =>
      group.split(' and ').every((raw) => featureMatches(raw, env)),
    )
}

/** env 下真实 tokens.css 的 :root 自定义属性最终值。 */
export function tokenValues(env: Env): Map<string, string> {
  const text = readFileSync(join(repoRoot, TOKEN_SHEET), 'utf8')
  return tokenValuesOf(postcss.parse(text), env)
}

/** 同名声明先按重要性再按源序取胜：重要声明不因其后普通声明而被覆盖，同重要性仍后写覆盖先写。 */
function applyRootDecl(
  entries: Map<string, { value: string; important: boolean }>,
  decl: postcss.Declaration,
): void {
  const current = entries.get(decl.prop)
  if (!current || !current.important || decl.important) {
    entries.set(decl.prop, {
      value: decl.value,
      important: decl.important === true,
    })
  }
}

/** 合并一个根规则的直接自定义属性声明，保留声明源序并排除普通样式属性。 */
function applyRootRule(
  entries: Map<string, { value: string; important: boolean }>,
  rule: postcss.Rule,
): void {
  for (const decl of rule.nodes ?? []) {
    if (decl.type === 'decl' && decl.prop.startsWith('--')) {
      applyRootDecl(entries, decl)
    }
  }
}

/** 选择器列表是否含 `:root` 分支（伪类名 ASCII 大小写不敏感）。 */
function hasRootBranch(selector: string): boolean {
  return postcss.list
    .comma(selector)
    .some((branch) => branch.toLowerCase() === ':root')
}

/** 可能命中或覆盖文档根、但取值未建模的分支（html、`:root.dark`、`:is(:root)` 等）。 */
function isUnmodeledRootBranch(branch: string): boolean {
  return (
    branch.toLowerCase() !== ':root' &&
    (isDocumentTokenSelector(branch) || /:root(?![\w-])/i.test(branch))
  )
}

/** 根相关自定义属性不支持原生规则嵌套；沿整条祖先链判定，不能只看最近的 &。 */
function assertRootNesting(decl: postcss.Declaration): void {
  const rules: postcss.Rule[] = []
  let context: postcss.AnyNode | undefined = decl.parent
  while (context) {
    if (context.type === 'rule') rules.push(context)
    context = context.parent
  }
  if (
    rules.length > 1 &&
    rules.some(
      (rule) =>
        hasRootBranch(rule.selector) ||
        postcss.list.comma(rule.selector).some(isUnmodeledRootBranch),
    )
  ) {
    throw new Error(`TOKEN_ROOT_NESTING_UNMODELED: ${decl.prop}`)
  }
}

/** 根令牌未建模的规则嵌套、at-rule 上下文/声明布局必须显式失败。 */
function assertRootContexts(root: postcss.Root): void {
  root.walkAtRules(/^property$/i, (rule) => {
    throw new Error(`TOKEN_ROOT_AT_RULE_UNMODELED: @property ${rule.params}`)
  })
  root.walkDecls(/^--/, (decl) => {
    assertRootNesting(decl)
    let rule: postcss.AnyNode | undefined = decl.parent
    while (rule?.type === 'atrule') rule = rule.parent
    if (rule?.type !== 'rule') return
    if (postcss.list.comma(rule.selector).some(isUnmodeledRootBranch)) {
      throw new Error(
        `TOKEN_ROOT_SELECTOR_UNMODELED: ${rule.selector} ${decl.prop}`,
      )
    }
    if (!hasRootBranch(rule.selector)) return
    let context: postcss.AnyNode | undefined = decl.parent
    while (context) {
      if (
        context.type === 'atrule' &&
        (context.name.toLowerCase() !== 'media' || context === decl.parent)
      ) {
        throw new Error(
          `TOKEN_ROOT_AT_RULE_UNMODELED: @${context.name} ${context.params}`,
        )
      }
      context = context.parent
    }
  })
}

/**
 * env 下给定根节点 :root 自定义属性最终值（媒体块按 env 进入）：同名声明
 * 先按重要性（!important 优先于普通声明）再按源序取胜——重要声明不因其后
 * 出现普通声明而被覆盖，同重要性仍后写覆盖先写。未建模的根 at-rule 上下文
 * 以 TOKEN_ROOT_AT_RULE_UNMODELED 显式拒绝，包括非活跃 media 内的未知块。
 * 支持 media 包住根规则；反向内嵌 at-rule 同样拒绝；根相关样式规则嵌套
 * 报 TOKEN_ROOT_NESTING_UNMODELED，包括媒体中间层及未活跃分支。
 * 选择器列表中的 `:root` 分支按根规则取值；其他可能命中文档根的选择器上的
 * 自定义属性以 TOKEN_ROOT_SELECTOR_UNMODELED 拒绝。
 */
export function tokenValuesOf(
  root: postcss.Root,
  env: Env,
): Map<string, string> {
  assertRootContexts(root)
  const entries = new Map<string, { value: string; important: boolean }>()
  const walk = (container: postcss.Container): void => {
    for (const node of container.nodes ?? []) {
      if (node.type === 'atrule' && node.name.toLowerCase() === 'media') {
        if (mediaMatches(node.params, env)) walk(node)
        continue
      }
      if (node.type !== 'rule') continue
      if (!hasRootBranch(node.selector)) {
        walk(node)
        continue
      }
      applyRootRule(entries, node)
    }
  }
  walk(root)
  return new Map([...entries].map(([name, entry]) => [name, entry.value]))
}

/** 仅定位不透明内容之外的 var()，返回的偏移可直接用于原始值切片。 */
function variableStart(value: string): number {
  return maskCssOpaque(value).indexOf('var(')
}

/** 迭代消解真实 var() 引用链（深度限 12，防循环），字符串/URL 保持原样。 */
export function resolveChain(
  value: string,
  tokens: Map<string, string>,
): string {
  let current = value
  for (let i = 0; i < 12 && variableStart(current) >= 0; i += 1) {
    const syntax = maskCssOpaque(current)
    current = current.replace(
      /var\(\s*(--[\w-]+)\s*\)/g,
      (whole, name: string, offset: number) =>
        syntax.startsWith('var(', offset) ? (tokens.get(name) ?? whole) : whole,
    )
  }
  if (variableStart(current) >= 0)
    throw new Error(`var() 链过深或悬空: ${value}`)
  return current
}

/** 展示色简写及图像属性：字面色值必须经注册表豁免（box-shadow/遮罩除外）。 */
const DISPLAY_PROPS = new Set([
  'background',
  'background-image',
  'outline',
  'text-decoration',
  'text-emphasis',
  'text-shadow',
  'column-rule',
  'fill',
  'stroke',
  '-webkit-text-stroke',
  'border-image',
  'border-image-source',
])

/** border 系结构式分类：总体/四向/逻辑方向 × 简写或 -color 长形。 */
const BORDER_COLOR_PROP =
  /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?$/

/** color 与全部标准 `-color` 长形（含厂商前缀）；自定义属性不匹配。 */
const COLOR_LONGHAND = /^(?:-[a-z]+-)?(?:[a-z]+-)*color$/

/** 属性是否承载展示色（构造中的 border 字面色同样受禁）。 */
export function isDisplayColorProp(prop: string): boolean {
  return (
    DISPLAY_PROPS.has(prop) ||
    BORDER_COLOR_PROP.test(prop) ||
    COLOR_LONGHAND.test(prop)
  )
}

/** 值内真实 var() 引用名（含 fallback，排除字符串/URL；用于依赖图及消费闭包）。 */
export function allVarRefs(value: string): string[] {
  return [...maskCssOpaque(value).matchAll(/var\(\s*(--[\w-]+)/g)].map(
    (m) => m[1]!,
  )
}

/** 带上下文的声明：condition 为外层 at-rule 链（名 + 前置，空串 = 无条件）；important 供局部自定义属性按重要性选胜。 */
export interface SheetDecl {
  selector: string
  condition: string
  prop: string
  value: string
  important: boolean
}

/** 标准属性名 ASCII 大小写不敏感，归一为小写；自定义属性名保持大小写敏感。 */
export function normalizeProp(prop: string): string {
  return prop.startsWith('--') ? prop : prop.toLowerCase()
}

/** 局部定义仅支持外层 media；其他上下文须明确拒绝，不能假定其总是生效。 */
function assertLocalContext(decl: postcss.Declaration): void {
  let context: postcss.AnyNode | undefined = decl.parent
  while (context) {
    if (context.type === 'atrule' && context.name.toLowerCase() !== 'media') {
      throw new Error(
        `TOKEN_LOCAL_AT_RULE_UNMODELED: @${context.name} ${context.params}`,
      )
    }
    context = context.parent
  }
}

/** 文档元素的复合选择器起始形态；函数伪类、转义与命名空间按契约保留边界。 */
const DOCUMENT_TARGET = /^(?::root|html|body|\*)(?=$|[.:[#])/i

/** 简单组合器链按终点判断文档覆盖；通配终点仅在全局链中受限，保留 `.card > *` 局部定义。 */
function isDocumentTokenSelector(selector: string): boolean {
  const parts = postcss.list.split(
    selector,
    [' ', '\n', '\t', '\r', '\f', '>', '+', '~'],
    false,
  )
  const target = parts[parts.length - 1] ?? ''
  if (!DOCUMENT_TARGET.test(target)) return false
  return (
    !target.startsWith('*') || parts.every((part) => DOCUMENT_TARGET.test(part))
  )
}

/** 带文件来源的组件表不得另定义全局令牌；无来源语义夹具仍可模拟独立级联。 */
function assertGlobalTokenSource(root: postcss.Root): void {
  const file = root.source?.input.file
  const isSource = file === join(repoRoot, TOKEN_SHEET)
  // @property 注册总是全局生效，夹具也无法把它限定在局部级联内。
  root.walkAtRules(/^property$/i, (rule) => {
    const code = isSource
      ? 'TOKEN_ROOT_AT_RULE_UNMODELED'
      : 'TOKEN_GLOBAL_OUTSIDE_SOURCE'
    throw new Error(`${code}: ${file ?? '<fixture>'} @property ${rule.params}`)
  })
  if (!file || isSource) return
  root.walkRules((rule) => {
    if (!postcss.list.comma(rule.selector).some(isDocumentTokenSelector)) return
    const definition = rule.nodes.find(
      (node) => node.type === 'decl' && node.prop.startsWith('--'),
    )
    if (definition?.type === 'decl') {
      throw new Error(
        `TOKEN_GLOBAL_OUTSIDE_SOURCE: ${file} ${rule.selector} ${definition.prop}`,
      )
    }
  })
}

/** 枚举前验证整表布局，防止嵌套规则或未建模局部定义从任何扫描入口漏过。 */
function assertSheetContexts(root: postcss.Root): void {
  root.walkRules((rule) => {
    if (
      rule.nodes.some((node) => node.type === 'rule' || node.type === 'atrule')
    ) {
      throw new Error(`TOKEN_SHEET_NESTING_UNMODELED: ${rule.selector}`)
    }
  })
  assertGlobalTokenSource(root)
  root.walkDecls(/^--/, assertLocalContext)
}

/** 声明及上下文；真实组件输入须带 from 来源，未建模布局/定义以稳定错误码拒绝。 */
export function* sheetDecls(root: postcss.Root): Generator<SheetDecl> {
  assertSheetContexts(root)
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

/** 全局作用域选择器：其上的自定义属性对文档内任何规则可达。 */
const GLOBAL_SCOPES = new Set([':root', 'html', 'body', '*'])

/**
 * 自定义属性 initial 与文档根 unset 为保证无效值；其余 CSS-wide 继承/回滚
 * 尚未建模，明确拒绝，不能将原关键字误当作消费属性的合法取值。
 */
function isGuaranteedInvalid(value: string, selector: string): boolean {
  const keyword = value.trim().toLowerCase()
  if (keyword === 'initial') return true
  if (keyword === 'unset') {
    const documentRoot = selector
      .split(',')
      .map((s) => s.trim())
      .every((s) => s === ':root' || s === 'html')
    if (documentRoot) return true
  }
  if (/^(unset|inherit|revert|revert-layer)$/.test(keyword)) {
    throw new Error(`TOKEN_CSS_WIDE_UNMODELED: ${selector} ${keyword}`)
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
export interface LocalDef {
  selector: string
  condition: string
  value: string
  important: boolean
}

/**
 * at-rule 条件链在 env 下是否成立（空串无条件恒真）。条件链由 sheetDecls
 * 拼接为 `@media <params>;` 序列；仅 @media 段参与环境求值，其余 at-rule
 * （@keyframes/@supports 等）对普通声明保留扫描；这些上下文中的局部定义
 * 已由 sheetDecls 拒绝，不能借此分支成为无条件可用值。
 */
export function conditionActive(condition: string, env: Env): boolean {
  if (condition === '') return true
  return condition
    .split(';')
    .map((seg) => seg.trim())
    .filter((seg) => /^@media\s/i.test(seg))
    .every((seg) => mediaMatches(seg.replace(/^@media\s+/i, ''), env))
}

/**
 * 定义点列表是否选择器覆盖引用点：逗号选择器**逐分支**判定——每一个引用
 * 分支都须有定义方的某一分支覆盖（任一分支不可达即整条判悬空，该分支运行
 * 时计算色失效）。at-rule 条件与环境可达性由调用方按 env 判定。
 */
export function scopeReaches(
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
export function localDefinitions(root: postcss.Root): Map<string, LocalDef[]> {
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
 * 同一元素内重要性优先于源序的取胜：若存在重要声明/定义，只在其中取源序最后一项；
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

/** 已建模的简单后代/子代链中，定义元素到消费元素的距离；复合延续仍在同元素。 */
function inheritanceDistance(definer: string, referencer: string): number {
  if (!selectorReaches(definer, referencer)) return Infinity
  if (definer === '*' || definer === referencer) return 0
  if (referencer.startsWith(definer)) {
    return referencer.slice(definer.length).split(/[\s>]+/).length - 1
  }
  // 全局根定义是简单局部选择器链之外的继承来源；body 比文档根更近。
  const localDepth = referencer.split(/[\s>]+/).length
  return localDepth + (definer === 'body' ? 0 : 1)
}

/** 先限定最近定义元素，再让调用方在同元素的候选间应用重要性与源序。 */
function nearestDefinitions(defs: LocalDef[], referencer: string): LocalDef[] {
  const candidates = defs.map((def) => ({
    def,
    distance: Math.min(
      ...def.selector
        .split(',')
        .map((branch) => inheritanceDistance(branch.trim(), referencer)),
    ),
  }))
  const nearest = Math.min(...candidates.map(({ distance }) => distance))
  return candidates
    .filter(({ distance }) => distance === nearest)
    .map(({ def }) => def)
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
export interface WiringCtx {
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
  for (
    let start = variableStart(rest);
    start >= 0;
    start = variableStart(rest)
  ) {
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
export function unresolvedRefsIn(decl: SheetDecl, ctx: WiringCtx): string[] {
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
export function danglingRefs(
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
 * 单个选择器分支在 env 下的具体值：根令牌被该分支可达且活跃的局部定义
 * 遮蔽；先定位最近定义元素，使指定值优先于祖先继承值，然后在同元素的
 * 活跃定义之间按重要性和源序取胜。保证无效的自定义属性进入 fallback。
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
    const winner = pickWinner(nearestDefinitions(usable, decl.selector))
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
export function displayValueIn(decl: SheetDecl, ctx: WiringCtx): string | null {
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
  const start = variableStart(value)
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

/** 真实样式表和夹具共用的类型扫描入口：逐活跃环境、逐选择器分支报告实际无效值。 */
export function displayTypeErrors(root: postcss.Root, env: Env): string[] {
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

/**
 * 在给定根节点内按完整选择器找规则：须**唯一且无条件**（不处于任何
 * at-rule 内）——媒体块内同名规则会使生效值随环境分叉，违背黄金接线
 * 「恒值」前提；同名重复规则使文本序后位遮蔽先位，定位失真。选择器
 * 列表逐分支匹配：后续规则若在逗号分支中含目标选择器（如
 * `.other, .pw-dialog-danger { ... }`）仍能以同等特异性覆盖目标规则，
 * 也计入命中——不按整选择器字符串相等。sheet 仅用于错误信息；缺失/
 * 重复/条件化均抛错防测试静默空过。
 */
export function ruleIn(
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

/** 规则内该属性的生效值：属性名先按标准大小写归一，!important 声明优先于普通声明，同重要性取源序最后一条。 */
export function declOf(rule: postcss.Rule, prop: string): string {
  return winningDecl(rule, [prop]).value
}

/** 一组互相覆盖的属性（如简写与长形）在规则内的胜出声明，取胜规则同 declOf。 */
export function winningDecl(
  rule: postcss.Rule,
  props: readonly string[],
): postcss.Declaration {
  const targets = new Set(props.map(normalizeProp))
  const decls = rule.nodes.filter(
    (node): node is postcss.Declaration =>
      node.type === 'decl' && targets.has(normalizeProp(node.prop)),
  )
  if (decls.length === 0) {
    throw new Error(`${rule.selector} 缺少 ${props.join('/')} 声明`)
  }
  const important = decls.filter((decl) => decl.important)
  const winners = important.length > 0 ? important : decls
  return winners[winners.length - 1]!
}
