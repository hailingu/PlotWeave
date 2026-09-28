// @vitest-environment node
/**
 * TSX/TS/SVG 显示色令牌契约（issue #362）：扫描器与登记表自
 * sheetTokens.test.ts 外置为本文件（评审 4114444162：测试文件 ≤1800 行
 * 上限），CSS 侧契约仍在 sheetTokens.test.ts。语义与键口径见
 * docs/css-token-contract.md「组件源码侧」段落。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { hasColorLiteral } from './cssColorContract'
import { allVarRefs, isDisplayColorProp } from './sheetTokensEngine'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path: string): string =>
  readFileSync(join(repoRoot, path), 'utf8')

/**
 * TSX/TS/SVG 显示色扫描（issue #362：守卫范围从 CSS 扩展到组件与种子
 * 源码）。以 TypeScript AST 抽取生产源码中显示色承载点的字符串字面量
 * ——JSX 显示色属性与显示色对象键（含 gradient，覆盖持久化种子数据）；
 * SVG 无 AST，按 fill/stroke/stop-color 属性文本扫描。注释与无关字符串
 * （issue 编号引用等）不进 AST 字面量位点，天然不可见。扫描键集不包含
 * 用户内容数组（如头像渐变色板），维持 #262 的既有范围区别。
 */
const JSX_COLOR_SCAN_SKIP = [
  'src/styles/cssColorContract.ts',
  'src/styles/cssValueSyntax.ts',
  'src/styles/sheetRuleQuery.ts',
  'src/styles/sheetTokensEngine.ts',
  'src/moduleGraph.ts',
  'src/model/convertFixtures.ts',
  'src/editor/ai/testGraphs.ts',
]

/**
 * 承载显示色的 JSX 属性名与对象键判定（评审 4113805575）：camelCase 转
 * CSS 连字符形后复用 CSS 侧 `isDisplayColorProp` 分类——单一事实源，覆盖
 * background-image、四向/逻辑边框颜色等全部长形，键集不得自行枚举产生
 * 绕过面。前导大写按 React 厂商前缀约定保留前导 `-`（`WebkitTextStroke`
 * → `-webkit-text-stroke`，评审 4113846195）；`gradient`/`cover` 是用户
 * 内容通道的对象键扩展（种子头像渐变与封面，#262 边界，issue #362），
 * 不在 CSS 属性分类内。非显示键不产生出现点。
 */
function displayColorKeyOf(name: string): string | null {
  const kebab = name.replace(/([A-Z])/g, '-$1').toLowerCase()
  if (kebab === 'gradient' || kebab === 'cover') return kebab
  return isDisplayColorProp(kebab) ? kebab : null
}

/** 包装表达式的联合节点形态（issue #396）：解包目标类型守卫的收窄类型。 */
type WrapperExpression =
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.TypeAssertion
  | ts.NonNullExpression
  | ts.SatisfiesExpression

/**
 * 包装表达式判定（issue #396）：括号/as/尖括号断言/非空断言/satisfies
 * 只改变节点形态不改变语义——值侧静态抽取与赋值目标分类共用同一
 * 解包口径，等价合法形态不得因包装绕过登记。
 */
function isWrapperExpression(node: ts.Expression): node is WrapperExpression {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
}

/** 包装表达式递归解包（issue #396）：多层包装（嵌套括号等）一并剥离。 */
function unwrapExpression(node: ts.Expression): ts.Expression {
  return isWrapperExpression(node) ? unwrapExpression(node.expression) : node
}

/**
 * 静态字符串值递归抽取（评审 4113886895）：字符串/无替换模板字面量、
 * JSX 表达式容器（评审 4113927266）、包装表达式（as const/尖括号断言/
 * 括号/非空断言/satisfies）解包、`??`/`||`/`&&` 两侧与三元分支的静态
 * 字面都进入登记口径——等价静态入口不得因节点形态绕过（尖括号断言仅
 * .ts 合法，评审 4114274468）；动态表达式不产生静态文本。包装判定与
 * 赋值目标解包共用 isWrapperExpression/unwrapExpression（issue #396）。
 */
function staticTextsOf(node: ts.Expression | undefined): string[] {
  if (node === undefined) return []
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text]
  }
  if (ts.isJsxExpression(node)) {
    return staticTextsOf(node.expression)
  }
  if (isWrapperExpression(node)) {
    return staticTextsOf(node.expression)
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    return [...staticTextsOf(node.left), ...staticTextsOf(node.right)]
  }
  if (ts.isConditionalExpression(node)) {
    return [...staticTextsOf(node.whenTrue), ...staticTextsOf(node.whenFalse)]
  }
  return []
}

/** 静态属性名候选：标识符/字符串名/数字名直取；计算属性名递归抽取
 * 静态文本（`{ ['color']: … }`，评审 4113886895）。 */
function staticPropertyNameTexts(name: ts.PropertyName): string[] {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return [name.text]
  }
  if (ts.isComputedPropertyName(name)) return staticTextsOf(name.expression)
  return []
}

/** SVG 经 happy-dom 解析为 XML 文档后按元素属性检查——不匹配原始
 * 文本：注释、引号风格与排版不影响判定（评审 4113886903，AGENTS.md
 * 「经语言解析器或验证器验证语义」）。 */
const svgDomParser = new new Window().DOMParser()

interface JsxColorOccurrence {
  file: string
  context: string
  value: string
}

function discoverTsSvgSources(): { path: string; content: string }[] {
  const entries = readdirSync(join(repoRoot, 'src'), {
    encoding: 'utf8',
    recursive: true,
  })
  return entries
    .map((name) => `src/${name.replace(/\\/g, '/')}`)
    .filter((path) => /\.(tsx?|svg)$/.test(path))
    .filter(
      (path) => !/\.test\.tsx?$/.test(path) && !path.endsWith('.test-d.ts'),
    )
    .filter((path) => !JSX_COLOR_SCAN_SKIP.includes(path))
    .sort()
    .map((path) => ({ path, content: read(path) }))
}

/**
 * 对象字面量的显示色出现点：显示键承载的字面，加上同对象内被显示键经
 * var() 消费的内联自定义属性定义侧字面（评审 4113994776——镜像 CSS 侧
 * 可达局部别名检查，消除「定义并消费」别名对的入口分叉）；未被显示键
 * 消费的自定义属性不入契约（与 CSS 侧可达性同口径）。
 */
function objectLiteralOccurrences(
  file: string,
  obj: ts.ObjectLiteralExpression,
): JsxColorOccurrence[] {
  const pairs = obj.properties.filter(ts.isPropertyAssignment).flatMap((p) => {
    const texts = staticTextsOf(p.initializer)
    return staticPropertyNameTexts(p.name).map((name) => ({ name, texts }))
  })
  const directRefs = new Set(
    pairs
      .filter(({ name }) => displayColorKeyOf(name) !== null)
      .flatMap(({ texts }) => texts.flatMap((t) => allVarRefs(t))),
  )
  // 消费闭包沿别名链递归展开（评审 4114228857）：--alias 被 color 引用、
  // 其定义又引用 --tone 时，--tone 的字面同入登记口径；seen 防环，
  // 镜像 CSS 侧 displayConsumedDefs 的可达闭包语义。
  const defs = new Map(
    pairs
      .filter(({ name }) => name.startsWith('--'))
      .map(({ name, texts }) => [name, texts]),
  )
  const consumedNames = new Set(directRefs)
  const queue = [...directRefs]
  while (queue.length > 0) {
    const refs = (defs.get(queue.pop()!) ?? []).flatMap((t) => allVarRefs(t))
    for (const ref of refs) {
      if (!consumedNames.has(ref)) {
        consumedNames.add(ref)
        queue.push(ref)
      }
    }
  }
  const out: JsxColorOccurrence[] = []
  for (const { name, texts } of pairs) {
    const key = displayColorKeyOf(name)
    const consumed = name.startsWith('--') && consumedNames.has(name)
    if (key === null && !consumed) continue
    for (const value of texts) {
      if (hasColorLiteral(value)) {
        out.push({ file, context: key ?? name, value })
      }
    }
  }
  return out
}

/**
 * 增量属性赋值入口（评审 4114047062）：`style.color = '…'` 与
 * `style['backgroundColor'] = '…'` 的静态字面与对象键同口径受检——
 * 合法且静态的显示色硬编码不因逐步构造而绕过。左值分类前先递归解包
 * 包装表达式（issue #396）：`(style.color) = '…'` 等括号（含嵌套）
 * 与断言包装的合法形态按同一键口径受检。
 */
/**
 * 能写入右值静态字面的赋值运算符：普通等号与三种逻辑赋值（`??=`/`||=`/
 * `&&=` 写入静态回退值，评审 4114116865）。复合算术赋值（`+=` 等）是
 * 对既有值的修改而非整值写入，不在口径内。
 */
const WRITING_ASSIGNMENT_OPS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
])

function assignmentOccurrences(
  file: string,
  node: ts.BinaryExpression,
): JsxColorOccurrence[] {
  if (!WRITING_ASSIGNMENT_OPS.has(node.operatorToken.kind)) return []
  // 左值先解包（issue #396）：括号/断言包装改变节点形态，解包后与直
  // 赋值同口径分类
  const target = unwrapExpression(node.left)
  // 键候选全部遍历（评审 4114362293）：多候选计算键（如三元下标）逐候选
  // 分类，非显示键候选不得遮蔽同表达式中的显示键候选
  let names: string[]
  if (ts.isPropertyAccessExpression(target)) names = [target.name.text]
  else if (ts.isElementAccessExpression(target)) {
    names = staticTextsOf(target.argumentExpression)
  } else {
    names = []
  }
  const out: JsxColorOccurrence[] = []
  for (const name of names) {
    const key = displayColorKeyOf(name)
    if (key === null) continue
    for (const value of staticTextsOf(node.right)) {
      if (hasColorLiteral(value)) {
        out.push({ file, context: key, value })
      }
    }
  }
  return out
}

/** 单个 TS/TSX 源的显示色字面出现点：JSX 属性与对象属性的字符串字面量。 */
function colorOccurrencesOfSource(
  file: string,
  content: string,
): JsxColorOccurrence[] {
  const out: JsxColorOccurrence[] = []
  const sf = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node)) {
      const key = displayColorKeyOf(node.name.getText(sf))
      for (const value of staticTextsOf(node.initializer)) {
        // key 非显示键只抑制发射，不抑制下探——style 对象的内层属性
        // （backgroundImage 等）仍须被访问
        if (key !== null && hasColorLiteral(value)) {
          out.push({ file, context: key, value })
        }
      }
    } else if (ts.isObjectLiteralExpression(node)) {
      // 对象属性统一在对象层级处理（含内联自定义属性别名分析）
      out.push(...objectLiteralOccurrences(file, node))
    } else if (ts.isBinaryExpression(node)) {
      // 赋值类二元表达式（普通等号与逻辑赋值）由助手按运算符过滤
      out.push(...assignmentOccurrences(file, node))
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return out
}

/** SVG 属性文本扫描（无 AST）：只认双引号形态的显示色属性。 */
function svgColorOccurrences(
  content: string,
): { context: string; value: string }[] {
  const doc = svgDomParser.parseFromString(content, 'image/svg+xml')
  const out: { context: string; value: string }[] = []
  for (const element of doc.querySelectorAll('*')) {
    for (const attr of ['fill', 'stroke', 'stop-color']) {
      const value = element.getAttribute(attr)
      if (value !== null && hasColorLiteral(value)) {
        out.push({ context: attr, value })
      }
    }
  }
  return out
}

/** 全部生产 TSX/TS/SVG 的显示色字面出现点（键 → 标签与条数）。 */
function tsxLiteralOccurrences(): Map<
  string,
  { label: string; count: number }
> {
  const out = new Map<string, { label: string; count: number }>()
  for (const source of discoverTsSvgSources()) {
    const occurrences = source.path.endsWith('.svg')
      ? svgColorOccurrences(source.content).map((occ) => ({
          file: source.path,
          ...occ,
        }))
      : colorOccurrencesOfSource(source.path, source.content)
    for (const occ of occurrences) {
      const key = `${occ.file}|${occ.context}|${occ.value}`
      const hit = out.get(key)
      if (hit) hit.count += 1
      else
        out.set(key, {
          label: `${occ.file} ${occ.context}: ${occ.value.trim()}`,
          count: 1,
        })
    }
  }
  return out
}

/**
 * TSX/SVG 显示色例外注册表（issue #362）：与 CSS 侧 STRUCTURE_EXCEPTIONS
 * 同款双向校验——新增未登记字面失败；条目过期或条数扩大也失败。
 * 用户内容种子（#262 边界）与无既有令牌的装饰色在此登记，不藏项。
 */
const TSX_COLOR_EXCEPTIONS: Readonly<
  {
    file: string
    context: string
    value: string
    count?: number
    reason: string
  }[]
> = [
  {
    file: 'src/editor/sampleData.ts',
    context: 'gradient',
    value: 'linear-gradient(135deg,#e0176e,#7f6cf0)',
    reason:
      '用户内容种子（#262 边界）：持久化头像渐变写入用户项目，令牌变更不回写既有数据',
  },
  {
    file: 'src/editor/sampleData.ts',
    context: 'gradient',
    value: 'linear-gradient(135deg,#00b3d8,#5e5ce6)',
    reason: '用户内容种子（#262 边界）：同上',
  },
  {
    file: 'src/home/WeaveCover.tsx',
    context: 'fill',
    value: '#7f6cf0',
    count: 2,
    reason:
      '装饰图案中间节点色：无既有令牌（新增令牌属设计决策，暂以例外登记，issue #362）',
  },
  {
    file: 'src/model/legacy.ts',
    context: 'gradient',
    value: 'linear-gradient(135deg,#8e8e93,#636366)',
    reason:
      '用户内容默认头像渐变：v0 迁移补建实体的兜底配色，持久化为用户数据（#262 边界，评审 4113886895）',
  },
  {
    file: 'src/home/projects.ts',
    context: 'cover',
    value: 'linear-gradient(160deg, #2b2f4c, #e0176e)',
    reason:
      '用户内容：示例项目的封面渐变（用户选定封面的内容通道，#262 边界，评审 4113886895）',
  },
  {
    file: 'src/projectStore/seeds.ts',
    context: 'cover',
    value: 'linear-gradient(160deg, #2b2f4c, #e0176e)',
    reason:
      '用户内容种子：首次播种写入用户项目的示例封面（#262 边界，同 home/projects.ts）',
  },
]

function tsxOccurrenceKey(
  file: string,
  context: string,
  value: string,
): string {
  return `${file}|${context}|${value}`
}

describe('TSX/SVG 显示色扫描与登记表（issue #362：双向校验同 CSS 侧语义）', () => {
  it('生产 TSX/TS/SVG 显示色承载点不硬编码色值（登记表内、值一致且不超已审计条数）', () => {
    const audited = new Map(
      TSX_COLOR_EXCEPTIONS.map((e) => [
        tsxOccurrenceKey(e.file, e.context, e.value),
        e.count ?? 1,
      ]),
    )
    const offenders: string[] = []
    for (const [key, hit] of tsxLiteralOccurrences()) {
      const audit = audited.get(key)
      if (audit === undefined) {
        offenders.push(`${hit.label}（${hit.count} 条，未审计）`)
      } else if (hit.count > audit) {
        offenders.push(`${hit.label}（${hit.count} 条 > 已审计 ${audit} 条）`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('登记表每项仍按已审计条数命中值一致的真实字面（修复/换值/条数变动后更新表项，防例外藏项）', () => {
    const live = tsxLiteralOccurrences()
    const stale = TSX_COLOR_EXCEPTIONS.filter((e) => {
      const key = tsxOccurrenceKey(e.file, e.context, e.value)
      return (live.get(key)?.count ?? 0) !== (e.count ?? 1)
    })
    expect(
      stale.map(
        (e) =>
          `${e.file} ${e.context}: ${e.value}（期望 ${e.count ?? 1} 条，实际 ${live.get(tsxOccurrenceKey(e.file, e.context, e.value))?.count ?? 0} 条）`,
      ),
      '以下 TSX/SVG 注册表项已不再按已审计条数命中字面，应更新或删除：',
    ).toEqual([])
  })
})

describe('TSX/SVG 扫描入口与键归一（issue #362，评审补强）', () => {
  it('扫描覆盖面非空且 SVG 文本入口语义正确（字面色命中，var()/none 不命中）', () => {
    expect(discoverTsSvgSources().length).toBeGreaterThan(0)
    expect(
      svgColorOccurrences(
        '<circle fill="#fff"/><path stroke="var(--x)"/><rect fill="none" stop-color="url(#g)"/>',
      ),
    ).toEqual([{ context: 'fill', value: '#fff' }])
  })

  it('背景图像长形键 camelCase 归一进入扫描：style 对象 backgroundImage 字面被点名（评审 4113805575）', () => {
    const occurrences = colorOccurrencesOfSource(
      'fixture.tsx',
      "export const a = <div style={{ backgroundImage: 'linear-gradient(#fff, #000)' }} />",
    )
    expect(occurrences).toEqual([
      {
        file: 'fixture.tsx',
        context: 'background-image',
        value: 'linear-gradient(#fff, #000)',
      },
    ])
  })

  it('React 厂商前缀键保留前导连字符：WebkitTextStroke 字面被点名（评审 4113846195）', () => {
    const occurrences = colorOccurrencesOfSource(
      'fixture.tsx',
      "export const a = <div style={{ WebkitTextStroke: '1px #fff' }} />",
    )
    expect(occurrences).toEqual([
      {
        file: 'fixture.tsx',
        context: '-webkit-text-stroke',
        value: '1px #fff',
      },
    ])
  })
})

describe('TSX/SVG 静态抽取与解析检查（issue #362，评审补强）', () => {
  it('等价静态键/值语法（字符串属性名与无替换模板字面量）同样进入扫描（评审 4113846198）', () => {
    const occurrences = colorOccurrencesOfSource(
      'fixture.ts',
      "export const a = { 'backgroundColor': '#fff' };\n" +
        'export const b = { color: `#f00` };',
    )
    expect(occurrences).toEqual([
      { file: 'fixture.ts', context: 'background-color', value: '#fff' },
      { file: 'fixture.ts', context: 'color', value: '#f00' },
    ])
  })

  it('静态抽取递归解包：计算属性名、as const 包装与 ?? 兜底字面量（评审 4113886895）', () => {
    const occurrences = colorOccurrencesOfSource(
      'fixture.ts',
      "export const a = { ['color']: '#fff' };\n" +
        "export const b = { fill: '#f00' as const };\n" +
        "export const c = { gradient: g ?? 'linear-gradient(135deg,#8e8e93,#636366)' };",
    )
    expect(occurrences).toEqual([
      { file: 'fixture.ts', context: 'color', value: '#fff' },
      { file: 'fixture.ts', context: 'fill', value: '#f00' },
      {
        file: 'fixture.ts',
        context: 'gradient',
        value: 'linear-gradient(135deg,#8e8e93,#636366)',
      },
    ])
  })

  it('SVG 经解析器检查属性：单引号命中、注释不误报（评审 4113886903）', () => {
    // 注释与属性用不同颜色判别：正则匹配会命中注释里的 #000（假来源）
    expect(
      svgColorOccurrences(
        "<!-- fill=\"#000\" --><rect fill='#fff' stroke='none'/>",
      ),
    ).toEqual([{ context: 'fill', value: '#fff' }])
  })

  it('JSX 表达式容器解包：fill={…} 与 as const 经容器均被点名（评审 4113927266）', () => {
    const occurrences = colorOccurrencesOfSource(
      'fixture.tsx',
      "export const a = <circle fill={'#fff'} />;\n" +
        "export const b = <stop stopColor={'#f00' as const} />;",
    )
    expect(occurrences).toEqual([
      { file: 'fixture.tsx', context: 'fill', value: '#fff' },
      { file: 'fixture.tsx', context: 'stop-color', value: '#f00' },
    ])
  })
})

describe('TSX/SVG 内联别名与多跳追踪（issue #362，评审补强）', () => {
  it('内联自定义属性别名：定义并被显示键经 var() 消费的字面进入登记（评审 4113994776）', () => {
    const occurrences = colorOccurrencesOfSource(
      'fixture.tsx',
      "export const a = <div style={{ '--tone': '#fff', color: 'var(--tone)' }} />;",
    )
    // 定义侧字面以自定义属性名为上下文进入登记（镜像 CSS 侧可达局部
    // 别名检查），消费侧 var() 引用本身不重复点名
    expect(occurrences).toEqual([
      { file: 'fixture.tsx', context: '--tone', value: '#fff' },
    ])
    // 未被显示键消费的内联自定义属性不入契约（与 CSS 侧可达性同口径）
    const unused = colorOccurrencesOfSource(
      'fixture.tsx',
      "export const b = <div style={{ '--tone': '#fff' }} />;",
    )
    expect(unused).toEqual([])
  })

  it('内联别名递归追踪：多跳链的源头定义侧字面进入登记（评审 4114228857）', () => {
    const occurrences = colorOccurrencesOfSource(
      'fixture.tsx',
      "export const a = <div style={{ '--tone': '#fff', '--alias': 'var(--tone)', color: 'var(--alias)' }} />;",
    )
    // 消费闭包沿 --alias 的定义追到 --tone：源头字面以 --tone 上下文
    // 进入登记；--alias 值无字面不发射
    expect(occurrences).toEqual([
      { file: 'fixture.tsx', context: '--tone', value: '#fff' },
    ])
    // 环保护：互相引用的别名不致穷举，链上字面仍登记
    const cyclic = colorOccurrencesOfSource(
      'fixture.tsx',
      "export const c = <div style={{ '--a': '#fff', '--b': 'var(--a)', color: 'var(--b)' }} />;",
    )
    expect(cyclic).toEqual([
      { file: 'fixture.tsx', context: '--a', value: '#fff' },
    ])
  })
})

describe('TSX/SVG 增量赋值与断言语法（issue #362，评审补强）', () => {
  it('尖括号类型断言解包：<const> 值与计算键被点名（评审 4114274468）', () => {
    const occurrences = colorOccurrencesOfSource(
      'fixture.ts',
      "export const a = { color: <const>'#fff' };\n" +
        "export const b = { [<const>'backgroundColor']: '#000' };",
    )
    expect(occurrences).toEqual([
      { file: 'fixture.ts', context: 'color', value: '#fff' },
      { file: 'fixture.ts', context: 'background-color', value: '#000' },
    ])
  })

  it('&& 短路分支：对象键与 JSX 属性的字面被点名（评审 4114295210）', () => {
    const objectForm = colorOccurrencesOfSource(
      'fixture.ts',
      "export const a = { color: override && '#fff' };",
    )
    expect(objectForm).toEqual([
      { file: 'fixture.ts', context: 'color', value: '#fff' },
    ])
    const jsxForm = colorOccurrencesOfSource(
      'fixture.tsx',
      "export const b = <circle fill={override && '#f00'} />;",
    )
    expect(jsxForm).toEqual([
      { file: 'fixture.tsx', context: 'fill', value: '#f00' },
    ])
  })

  it('增量样式属性赋值：属性访问与字符串下标赋值被点名（评审 4114047062）', () => {
    const occurrences = colorOccurrencesOfSource(
      'fixture.tsx',
      'export function f(style: { color?: string }) {\n' +
        "  style.color = '#fff';\n" +
        "  style['backgroundColor'] = '#000';\n" +
        '}',
    )
    expect(occurrences).toEqual([
      { file: 'fixture.tsx', context: 'color', value: '#fff' },
      { file: 'fixture.tsx', context: 'background-color', value: '#000' },
    ])
  })

  it('逻辑赋值运算符：??= 与 ||= 写入的静态回退色被点名（评审 4114116865）', () => {
    const occurrences = colorOccurrencesOfSource(
      'fixture.tsx',
      'export function f(style: {\n' +
        '  color?: string;\n' +
        '  backgroundColor?: string;\n' +
        '}) {\n' +
        "  style.color ??= '#fff';\n" +
        "  style.backgroundColor ||= '#000';\n" +
        '}',
    )
    expect(occurrences).toEqual([
      { file: 'fixture.tsx', context: 'color', value: '#fff' },
      { file: 'fixture.tsx', context: 'background-color', value: '#000' },
    ])
  })

  it('增量赋值的多候选计算键：全部分别分类，非显示键不遮蔽（评审 4114362293）', () => {
    const occurrences = colorOccurrencesOfSource(
      'fixture.tsx',
      'export function f(\n' +
        '  style: { width?: string; color?: string },\n' +
        '  flag: boolean,\n' +
        ') {\n' +
        "  style[flag ? 'width' : 'color'] = '#fff';\n" +
        '}',
    )
    // 首候选 width 非显示键不得遮蔽次候选 color：全部候选分别分类
    expect(occurrences).toEqual([
      { file: 'fixture.tsx', context: 'color', value: '#fff' },
    ])
  })

  it('括号包装的赋值目标：递归解包后与直赋值同口径受检（issue #396）', () => {
    const occurrences = colorOccurrencesOfSource(
      'fixture.tsx',
      'export function f(style: {\n' +
        '  color?: string;\n' +
        '  backgroundColor?: string;\n' +
        '}) {\n' +
        "  (style.color) = '#fff';\n" +
        "  (style['backgroundColor']) = '#000';\n" +
        "  ((style.color)) = '#f00';\n" +
        '}',
    )
    // 包装只改变节点形态不改变语义：括号（含嵌套）包裹的属性访问与
    // 下标目标解包后按既有键分类登记
    expect(occurrences).toEqual([
      { file: 'fixture.tsx', context: 'color', value: '#fff' },
      { file: 'fixture.tsx', context: 'background-color', value: '#000' },
      { file: 'fixture.tsx', context: 'color', value: '#f00' },
    ])
  })
})
