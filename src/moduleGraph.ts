import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import * as ts from 'typescript'

/**
 * src 模块依赖图的构建与环检测（issue 106 的回归守卫逻辑，供
 * moduleGraph.test.ts 消费；无任何应用侧导入者，不参与应用打包）。
 *
 * 用 TypeScript AST 解析维护模块（src 下非测试 .ts/.tsx）的相对边：
 * import / re-export / 动态 import() / import('…').Type 类型查询
 * （PR #116 评审 4000329365 补录——类型查询只存在于编译期，漏采会让
 * 反向类型环对编译期断言隐形）。外部包说明符不参与环构图，但由
 * buildSrcExternalEdges 单独采集（issue #266 的模型纯度守卫输入——
 * 无环是比分层纯度更弱的性质，框架运行时依赖须另查）；资源导入
 * （css/svg 等）在解析层显式分类而非静默跳过；无法解析的相对 TS 导入
 * 抛错——构图不健全比漏检更危险。
 */
/** 参与构图的关系边：target = 解析后的模块键，typeOnly = 是否仅类型边；
 * dynamic = 动态导入且说明符不可静态解析（PR #305 四轮评审：带替换模板
 * 等——运行时可加载任意模块，不进环构图，由模型纯度守卫 fail-closed）。 */
export interface ModuleEdge {
  target: string
  typeOnly: boolean
  dynamic?: boolean
}

/** 外部包说明符边（issue #266 守卫输入）：spec = 源码原始说明符
 * （如 '@xyflow/react'、'react/jsx-runtime'），typeOnly = 是否仅编译期；
 * dynamic 含义同 ModuleEdge。 */
export interface ExternalEdge {
  spec: string
  typeOnly: boolean
  dynamic?: boolean
}

/** 解析前的原始边：spec = 源文件中的说明符原文；dynamic = 动态导入且
 * 说明符不可静态解析（带替换模板等，spec 为表达式原文）。 */
export interface RawEdge {
  spec: string
  typeOnly: boolean
  dynamic?: boolean
}

/** 维护模块 = src 下的 .ts/.tsx 且非测试、非声明文件（与审计口径一致）。 */
const isMaintainedModule = (p: string): boolean =>
  /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.endsWith('.d.ts')

/** 深度优先枚举 src 下的维护模块（绝对路径）。 */
function listModules(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listModules(p))
    else if (isMaintainedModule(p)) out.push(p)
  }
  return out
}

/** 相对说明符的解析结论（判别联合）：module = 命中的 TS 模块路径；
 * asset = 资源导入（css/svg 等，非模块边）；unresolved = 无法解析。 */
type EdgeTargetResolution =
  { kind: 'module'; path: string } | { kind: 'asset' } | { kind: 'unresolved' }

/** 相对说明符 → 解析结论：兼容显式扩展名与目录 index 两种形态。 */
function resolveEdgeTarget(
  fromFile: string,
  spec: string,
): EdgeTargetResolution {
  const isModule = (p: string): boolean =>
    existsSync(p) && isMaintainedModule(p)
  const base = resolve(dirname(fromFile), spec)
  if (/\.(ts|tsx)$/.test(base))
    return isModule(base) ? { kind: 'module', path: base } : { kind: 'asset' }
  for (const cand of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (isModule(cand)) return { kind: 'module', path: cand }
  }
  // 落不到 TS 模块但文件存在 = 资源导入（css/svg 等），非模块边
  return existsSync(base) ? { kind: 'asset' } : { kind: 'unresolved' }
}

/** 单条 import 的原始边（外部包说明符同样返回，由调用方按需筛选；
 * null = 非字符串说明符）。编译期判定（PR #305 评审补强）：整句
 * import type，或无默认绑定且具名绑定全部 inline type（import
 * { type A, type B } 同样整条擦除）；混合值绑定仍是运行时边。
 * isTypeOnly 已废弃，相位修饰以 phaseModifier 为准（S1874） */
function edgeOfImport(node: ts.ImportDeclaration): RawEdge | null {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return null
  const clause = node.importClause
  const typeOnly =
    clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
    allNamedBindingsTypeOnly(clause)
  return { spec: node.moduleSpecifier.text, typeOnly }
}

/** 具名绑定全部 inline type 且无默认/命名空间绑定（PR #305 评审）：
 * 整条导入编译期擦除；空子句（import 'x'）与命名空间导入是运行时边。 */
function allNamedBindingsTypeOnly(
  clause: ts.ImportClause | undefined,
): boolean {
  if (clause === undefined || clause.name !== undefined) return false
  const named = clause.namedBindings
  if (named === undefined || !ts.isNamedImports(named)) return false
  return named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly)
}

/** export ... from '...' 的原始边：具名重导出在运行时仍执行目标模块；
 * 具名重导出全部 inline type（export { type A } from …）整条编译期
 * 擦除（PR #305 评审）。 */
function edgeOfExport(node: ts.ExportDeclaration): RawEdge | null {
  if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier))
    return null
  const clause = node.exportClause
  const typeOnly =
    node.isTypeOnly === true ||
    (clause !== undefined &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((e) => e.isTypeOnly))
  return { spec: node.moduleSpecifier.text, typeOnly }
}

/** 静态说明符判定（PR #305 三轮评审）：字符串或**无替换**模板字面量——
 * import(`react`) 是合法且静态可解析的动态导入，须采集；带替换的模板
 * 是真动态（运行时才定目标），不采集。 */
function isStaticSpecifier(
  node: ts.Node,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
}

/** 动态 import(…) 的原始边（恒为运行时边；PR #305 三轮评审：无替换
 * 模板字面量同属静态可解析说明符。PR #305 四轮评审：带替换模板等不可
 * 静态解析的动态导入采集为 dynamic 边——spec 为表达式原文，运行时可
 * 加载任意模块，不得静默丢弃）。 */
function edgeOfDynamicImport(node: ts.CallExpression): RawEdge | null {
  const arg = node.arguments[0]
  if (node.expression.kind !== ts.SyntaxKind.ImportKeyword || arg === undefined)
    return null
  if (isStaticSpecifier(arg)) return { spec: arg.text, typeOnly: false }
  // spec 剥掉定界符（引号/反引号），与静态边同形态——相对边筛选按首
  // 字符判相对/外部，带定界符会被误滤（PR #305 四轮评审）
  const raw = arg.getText(sfOfNode(node))
  return {
    spec: raw.length >= 2 ? raw.slice(1, -1) : raw,
    typeOnly: false,
    dynamic: true,
  }
}

/** 表达式所属源文件（动态边原文提取用）。 */
const sfOfNode = (node: ts.Node): ts.SourceFile => {
  let current: ts.Node = node
  while (current.parent !== undefined) current = current.parent
  return current as ts.SourceFile
}

/** import('...').Type 类型查询的原始边（恒为编译期边；PR #116 评审
 * 4000329365：AST 中它是 ImportTypeNode 而非 CallExpression，漏采会让
 * 反向类型环对编译期断言隐形）。 */
function edgeOfImportType(node: ts.ImportTypeNode): RawEdge | null {
  if (!ts.isLiteralTypeNode(node.argument)) return null
  if (!isStaticSpecifier(node.argument.literal)) return null
  return { spec: node.argument.literal.text, typeOnly: true }
}

/** 遍历 AST 收集单文件的原始边集（相对与外部包说明符都在内；
 * typeof import('…') 内层的 ImportTypeNode 经递归子节点同样命中）。 */
function edgesOfSourceFile(sf: ts.SourceFile): RawEdge[] {
  const edges: RawEdge[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const e = edgeOfImport(node)
      if (e) edges.push(e)
    } else if (ts.isExportDeclaration(node)) {
      const e = edgeOfExport(node)
      if (e) edges.push(e)
    } else if (ts.isCallExpression(node)) {
      const e = edgeOfDynamicImport(node)
      if (e) edges.push(e)
    } else if (ts.isImportTypeNode(node)) {
      const e = edgeOfImportType(node)
      if (e) edges.push(e)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return edges
}

/** 夹具解析入口：从内存源码文本提取相对边（测试直接验证语法形态覆盖，
 * 不落盘）。 */
export function relativeEdgesOfSource(
  code: string,
  kind: ts.ScriptKind = ts.ScriptKind.TS,
): RawEdge[] {
  const sf = ts.createSourceFile(
    'fixture.ts',
    code,
    ts.ScriptTarget.Latest,
    true,
    kind,
  )
  return edgesOfSourceFile(sf).filter((e) => e.spec.startsWith('.'))
}

/** 夹具解析入口：从内存源码文本提取外部包边（issue #266 守卫的反例
 * 验证入口，不落盘）。 */
export function externalEdgesOfSource(
  code: string,
  kind: ts.ScriptKind = ts.ScriptKind.TS,
): ExternalEdge[] {
  const sf = ts.createSourceFile(
    'fixture.tsx',
    code,
    ts.ScriptTarget.Latest,
    true,
    kind,
  )
  return externalEdgesOfAst(sf)
}

/** AST → 外部包边集：显式说明符 + JSX 隐式运行时边（PR #305 评审：
 * tsconfig jsx: react-jsx 下编译器为 JSX 合成 react/jsx-runtime 导入，
 * 源码 AST 不可见——不合成则模型层 JSX 会绕过框架运行时守卫）。 */
function externalEdgesOfAst(sf: ts.SourceFile): ExternalEdge[] {
  const out: ExternalEdge[] = edgesOfSourceFile(sf)
    .filter((e) => !e.spec.startsWith('.'))
    .map(({ spec, typeOnly, dynamic }) =>
      dynamic === true ? { spec, typeOnly, dynamic } : { spec, typeOnly },
    )
  if (containsJsx(sf)) out.push({ spec: 'react/jsx-runtime', typeOnly: false })
  return out
}

/** JSX 语法存在性：三种 JSX 子树根覆盖全部形态（.ts 文件不容 JSX，
 * 仅 .tsx 夹具与维护文件可能命中）。 */
function containsJsx(sf: ts.SourceFile): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return found
}

/** 单文件的已解析 AST（环构图与外部边采集共用）。 */
function parseSourceFile(file: string): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    kind,
  )
}

/** 解析失败的相对 TS 导入属构图不健全（可能掩盖环），直接报错而非跳过。
 * 外部包说明符不参与环构图（由 buildSrcExternalEdges 单独采集）；
 * dynamic 边（PR #305 四轮评审）目标运行时才定、无法静态解析，同样
 * 不进环构图——由模型纯度守卫 fail-closed。 */
function resolveEdgeKeys(
  file: string,
  keyOf: (p: string) => string,
): ModuleEdge[] {
  const sf = parseSourceFile(file)
  const out: ModuleEdge[] = []
  for (const e of edgesOfSourceFile(sf)) {
    if (e.dynamic === true)
      out.push({ target: e.spec, typeOnly: false, dynamic: true })
    else if (!e.spec.startsWith('.')) continue
    else {
      const resolved = resolveEdgeTarget(file, e.spec)
      if (resolved.kind === 'asset') continue
      if (resolved.kind === 'unresolved')
        throw new Error(`无法解析相对导入：${file} → ${e.spec}`)
      out.push({ target: keyOf(resolved.path), typeOnly: e.typeOnly })
    }
  }
  return out
}

/** 全图：键 = 相对 srcRoot 的 posix 路径（失败信息可读）。 */
export function buildSrcModuleGraph(
  srcRoot: string,
): Map<string, ModuleEdge[]> {
  const keyOf = (p: string): string => relative(srcRoot, p).split(sep).join('/')
  const edges = new Map<string, ModuleEdge[]>()
  for (const file of listModules(srcRoot)) edges.set(keyOf(file), [])
  for (const key of edges.keys()) {
    const file = resolve(srcRoot, key)
    edges.set(key, resolveEdgeKeys(file, keyOf))
  }
  return edges
}

/** 全图的外部包边（issue #266 守卫输入）：键与 buildSrcModuleGraph 同
 * 口径，值为该模块的外部包说明符边（spec 保持源码原样，不解析；含
 * JSX 隐式 react/jsx-runtime 运行时边，见 externalEdgesOfAst）。 */
export function buildSrcExternalEdges(
  srcRoot: string,
): Map<string, ExternalEdge[]> {
  const keyOf = (p: string): string => relative(srcRoot, p).split(sep).join('/')
  const edges = new Map<string, ExternalEdge[]>()
  for (const file of listModules(srcRoot)) {
    edges.set(keyOf(file), externalEdgesOfAst(parseSourceFile(file)))
  }
  return edges
}

/** 框架包说明符（运行时依赖禁止，issue #266）：react 家族与 React Flow。 */
const FRAMEWORK_PACKAGE = /^(react|react-dom|@xyflow\/react)/

/** 模型层运行时可达闭包（PR #305 二轮评审）：自 model/ 模块沿非
 * type-only 相对边可达的全部模块（含根）——model 经共享叶子（如
 * `src/uid.ts`，normalize*.ts 的运行时依赖）传递可达的模块都在闭包内；
 * 不可达的组件层（editor 面板/视图等）不在其中。 */
export function modelRuntimeClosure(
  graph: Map<string, ModuleEdge[]>,
): Set<string> {
  const closure = new Set<string>()
  const queue: string[] = []
  for (const key of graph.keys()) {
    if (!key.startsWith('model/')) continue
    closure.add(key)
    queue.push(key)
  }
  while (queue.length > 0) {
    const current = queue.pop()!
    for (const e of graph.get(current) ?? []) {
      // dynamic 边目标运行时才定，无法静态确定可达性——不计入闭包，
      // 由两守卫对边本身 fail-closed（PR #305 四轮评审）
      if (e.typeOnly || e.dynamic === true || closure.has(e.target)) continue
      closure.add(e.target)
      queue.push(e.target)
    }
  }
  return closure
}

/** 模型层框架运行时依赖违规（issue #266；PR #305 二轮评审升级为闭包
 * 口径）：自 model 沿运行时边可达闭包内的**任何**模块对框架包
 * （react / react-dom / @xyflow/react*）只允许 `import type` 编译期
 * 依赖——model 经共享叶子（uid.ts 等）传递引入框架同样破坏「运行时
 * 不依赖框架」。返回 `文件 → 包` 违规清单，空 = 通过；不可达组件层的
 * 框架值导入不误报。契约所有者：docs/data-model.md §2。 */
export function modelFrameworkRuntimeViolations(
  graph: Map<string, ModuleEdge[]>,
  external: Map<string, ExternalEdge[]>,
): string[] {
  const offenders: string[] = []
  for (const file of modelRuntimeClosure(graph)) {
    for (const e of external.get(file) ?? []) {
      // 动态不可解析导入（PR #305 四轮评审）：目标包运行时才定，
      // 框架依赖无法静态验证——fail-closed
      if (e.dynamic === true) {
        offenders.push(`${file} → 动态导入（不可静态解析）：${e.spec}`)
        continue
      }
      if (FRAMEWORK_PACKAGE.test(e.spec) && !e.typeOnly)
        offenders.push(`${file} → ${e.spec}`)
    }
  }
  return offenders
}

/** model → editor 运行时值依赖的白名单（issue #266）：登记的纯叶子
 * 规则模块（自身零导入）——graphRules（边/端口字面量与判别）与
 * settings（设定集默认值/归一化）。type-only 依赖不受限。 */
const MODEL_EDITOR_RUNTIME_ALLOWLIST = new Set([
  'editor/graphRules.ts',
  'editor/settings.ts',
])

/** 模型层 → editor 的运行时依赖越界（issue #266；PR #305 三轮评审升级
 * 为闭包口径）：运行时可达闭包内**任何**模块的 editor/ 值依赖只允许
 * 白名单纯叶子，其余 editor 模块（组件/hook/面板等）仅 type-only——
 * 经共享模块间接触达 editor 实现同样违规。返回 `文件 → 目标` 违规
 * 清单，空 = 通过。 */
export function modelEditorRuntimeViolations(
  graph: Map<string, ModuleEdge[]>,
): string[] {
  const offenders: string[] = []
  for (const file of modelRuntimeClosure(graph)) {
    for (const e of graph.get(file) ?? []) {
      // 动态不可解析导入（PR #305 四轮评审）优先于目标前缀判定：运行时
      // 可加载任意模块（含非白名单 editor 实现），白名单无法静态验证
      if (e.dynamic === true) {
        offenders.push(`${file} → 动态导入（不可静态解析）：${e.target}`)
        continue
      }
      if (!e.target.startsWith('editor/')) continue
      if (!e.typeOnly && !MODEL_EDITOR_RUNTIME_ALLOWLIST.has(e.target))
        offenders.push(`${file} → ${e.target}`)
    }
  }
  return offenders
}

/** 白名单目标的运行时叶子校验（PR #305 评审）：值依赖白名单成立的
 * 前提是目标自身无运行时出边（相对值边与任何外部包运行时边都算）——
 * 否则 model 经白名单获得传递性运行时依赖而守卫仍为空。type-only
 * 出边不破例。返回 `目标 → 边` 清单，空 = 通过。 */
export function allowlistRuntimeLeafViolations(
  graph: Map<string, ModuleEdge[]>,
  external: Map<string, ExternalEdge[]>,
): string[] {
  const offenders: string[] = []
  for (const target of MODEL_EDITOR_RUNTIME_ALLOWLIST) {
    for (const e of graph.get(target) ?? []) {
      if (!e.typeOnly) offenders.push(`${target} → ${e.target}`)
    }
    for (const e of external.get(target) ?? []) {
      if (!e.typeOnly) offenders.push(`${target} → ${e.spec}（外部）`)
    }
  }
  return offenders
}

/** Tarjan 强连通分量：仅类型边（typeOnly）也会成环，构图时不剔除。 */
function tarjanSccs(edges: Map<string, ModuleEdge[]>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const sccs: string[][] = []
  let counter = 0
  const strongconnect = (v: string): void => {
    index.set(v, counter)
    low.set(v, counter)
    counter += 1
    stack.push(v)
    onStack.add(v)
    for (const e of edges.get(v) ?? []) {
      if (!index.has(e.target)) {
        strongconnect(e.target)
        low.set(v, Math.min(low.get(v)!, low.get(e.target)!))
      } else if (onStack.has(e.target)) {
        low.set(v, Math.min(low.get(v)!, index.get(e.target)!))
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = []
      for (;;) {
        const w = stack.pop()!
        onStack.delete(w)
        scc.push(w)
        if (w === v) break
      }
      sccs.push(scc)
    }
  }
  for (const v of edges.keys()) if (!index.has(v)) strongconnect(v)
  return sccs
}

/** 在非平凡 SCC 内部找出一条具体环路径（键序列），失败信息可直接定位。 */
function cyclePathOf(
  scc: string[],
  edges: Map<string, ModuleEdge[]>,
): string[] {
  const members = new Set(scc)
  const start = scc[0]
  // SCC 非空由 Tarjan 构造保证；空表防御直接退回成员清单（issue #230）
  if (start === undefined) return [...scc]
  const path = [start]
  const onPath = new Set([start])
  const dfs = (cur: string): string[] | null => {
    for (const e of edges.get(cur) ?? []) {
      if (!members.has(e.target)) continue
      if (e.target === start) return [...path, start]
      if (onPath.has(e.target)) continue
      onPath.add(e.target)
      path.push(e.target)
      const found = dfs(e.target)
      if (found) return found
      path.pop()
      onPath.delete(e.target)
    }
    return null
  }
  return dfs(start) ?? [...scc]
}

/** 全图中的环：SCC 大小 > 1 或自环，各给一条可读环路径。 */
export function cyclesOf(edges: Map<string, ModuleEdge[]>): string[] {
  const cycles: string[] = []
  for (const scc of tarjanSccs(edges)) {
    if (scc.length > 1) cycles.push(cyclePathOf(scc, edges).join(' → '))
    else {
      const v = scc[0]
      if (v !== undefined && (edges.get(v) ?? []).some((e) => e.target === v))
        cycles.push(`${v} → ${v}`)
    }
  }
  return cycles.sort((a, b) => a.localeCompare(b))
}
