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
 * 反向类型环对编译期断言隐形）。外部包说明符不参与构图；资源导入
 * （css/svg 等）在解析层显式分类而非静默跳过；无法解析的相对 TS 导入
 * 抛错——构图不健全比漏检更危险。
 */
/** 参与构图的关系边：target = 解析后的模块键，typeOnly = 是否仅类型边。 */
export interface ModuleEdge {
  target: string
  typeOnly: boolean
}

/** 解析前的原始边：spec = 源文件中的相对说明符。 */
export interface RawEdge {
  spec: string
  typeOnly: boolean
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

/** 单条 import 的原始边（null = 非相对说明符，外部依赖不参与构图）。 */
function edgeOfImport(node: ts.ImportDeclaration): RawEdge | null {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return null
  const spec = node.moduleSpecifier.text
  if (!spec.startsWith('.')) return null
  const clause = node.importClause
  // 仅类型整体导入（import type {...}）擦除后不产生运行时边；
  // isTypeOnly 已废弃，相位修饰以 phaseModifier 为准（S1874）
  const typeOnly = clause?.phaseModifier === ts.SyntaxKind.TypeKeyword
  return { spec, typeOnly }
}

/** export ... from '...' 的原始边：具名重导出在运行时仍执行目标模块。 */
function edgeOfExport(node: ts.ExportDeclaration): RawEdge | null {
  if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier))
    return null
  const spec = node.moduleSpecifier.text
  if (!spec.startsWith('.')) return null
  return { spec, typeOnly: node.isTypeOnly === true }
}

/** 动态 import('...') 的原始边（恒为运行时边）。 */
function edgeOfDynamicImport(node: ts.CallExpression): RawEdge | null {
  if (
    node.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    !ts.isStringLiteral(node.arguments[0])
  )
    return null
  const spec = node.arguments[0].text
  if (!spec.startsWith('.')) return null
  return { spec, typeOnly: false }
}

/** import('...').Type 类型查询的原始边（恒为编译期边；PR #116 评审
 * 4000329365：AST 中它是 ImportTypeNode 而非 CallExpression，漏采会让
 * 反向类型环对编译期断言隐形）。 */
function edgeOfImportType(node: ts.ImportTypeNode): RawEdge | null {
  if (!ts.isLiteralTypeNode(node.argument)) return null
  if (!ts.isStringLiteral(node.argument.literal)) return null
  const spec = node.argument.literal.text
  if (!spec.startsWith('.')) return null
  return { spec, typeOnly: true }
}

/** 遍历 AST 收集单文件的原始边集（typeof import('…') 内层的
 * ImportTypeNode 经递归子节点同样命中）。 */
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
  return edgesOfSourceFile(sf)
}

/** 解析失败的相对 TS 导入属构图不健全（可能掩盖环），直接报错而非跳过。 */
function resolveEdgeKeys(
  file: string,
  keyOf: (p: string) => string,
): ModuleEdge[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    kind,
  )
  const out: ModuleEdge[] = []
  for (const e of edgesOfSourceFile(sf)) {
    const resolved = resolveEdgeTarget(file, e.spec)
    if (resolved.kind === 'asset') continue
    if (resolved.kind === 'unresolved')
      throw new Error(`无法解析相对导入：${file} → ${e.spec}`)
    out.push({ target: keyOf(resolved.path), typeOnly: e.typeOnly })
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
      if ((edges.get(v) ?? []).some((e) => e.target === v))
        cycles.push(`${v} → ${v}`)
    }
  }
  return cycles.sort((a, b) => a.localeCompare(b))
}
