import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * 模块依赖图的回归守卫（issue 106）：用 TypeScript AST 解析 src 下全部
 * 非测试模块的相对 import / re-export / 动态 import，构图后断言无环——
 * 与 issue 106 的基线审计同口径（147 个非测试模块、排除 *.test.*）。
 *
 * 依据 docs/development/software-engineering-standard.md「Dependency
 * Design」：维护模块之间禁止循环依赖，解环靠明确归属、抽取稳定契约，
 * 不靠宽化类型或忽略规则。编译期图（含 import type 的擦除前边）与运行
 * 时图（擦除类型后仍存在的边）分别断言：类型反向边造成的环同样算环，
 * 而运行时图无环是既有边界，回归时一并守住。
 */

/** src 根目录：测试文件位于 src/ 下，直接锚定自身位置。 */
const SRC_ROOT = fileURLToPath(new URL('./', import.meta.url))

/** 参与构图的关系边：target = 解析后的模块键，typeOnly = 是否仅类型边。 */
interface ModuleEdge {
  target: string
  typeOnly: boolean
}

/** 解析前的原始边：spec = 源文件中的相对说明符。 */
interface RawEdge {
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

/** 相对说明符 → 解析结果：兼容显式扩展名与目录 index 两种形态。 */
function resolveEdgeTarget(
  fromFile: string,
  spec: string,
): string | 'asset' | null {
  const isModule = (p: string): boolean =>
    existsSync(p) && isMaintainedModule(p)
  const base = resolve(dirname(fromFile), spec)
  if (/\.(ts|tsx)$/.test(base)) return isModule(base) ? base : 'asset'
  for (const cand of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (isModule(cand)) return cand
  }
  // 落不到 TS 模块但文件存在 = 资源导入（css/svg 等），非模块边
  return existsSync(base) ? 'asset' : null
}

/** 单条 import 的原始边（null = 非相对说明符，外部依赖不参与构图）。 */
function edgeOfImport(node: ts.ImportDeclaration): RawEdge | null {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return null
  const spec = node.moduleSpecifier.text
  if (!spec.startsWith('.')) return null
  const clause = node.importClause
  // 仅类型整体导入（import type {...}）擦除后不产生运行时边
  const typeOnly = clause?.isTypeOnly === true
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

/** 解析单个源文件的原始边集（相对 import / re-export / 动态 import）。 */
function edgesOfModule(file: string): RawEdge[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    kind,
  )
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
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return edges
}

/** 解析失败的相对 TS 导入属构图不健全（可能掩盖环），直接报错而非跳过。 */
function resolveEdgeKeys(
  file: string,
  keyOf: (p: string) => string,
): ModuleEdge[] {
  const out: ModuleEdge[] = []
  for (const e of edgesOfModule(file)) {
    const resolved = resolveEdgeTarget(file, e.spec)
    if (resolved === 'asset') continue
    if (resolved === null)
      throw new Error(`无法解析相对导入：${file} → ${e.spec}`)
    out.push({ target: keyOf(resolved), typeOnly: e.typeOnly })
  }
  return out
}

/** 全图：键 = 相对 src 的 posix 路径（失败信息可读）。 */
function buildGraph(): Map<string, ModuleEdge[]> {
  const keyOf = (p: string): string =>
    relative(SRC_ROOT, p).split(sep).join('/')
  const edges = new Map<string, ModuleEdge[]>()
  for (const file of listModules(SRC_ROOT)) edges.set(keyOf(file), [])
  for (const key of edges.keys()) {
    const file = resolve(SRC_ROOT, key)
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

/** 全图中的环： SCC 大小 > 1 或自环，各给一条可读环路径。 */
function cyclesOf(edges: Map<string, ModuleEdge[]>): string[] {
  const cycles: string[] = []
  for (const scc of tarjanSccs(edges)) {
    if (scc.length > 1) cycles.push(cyclePathOf(scc, edges).join(' → '))
    else {
      const v = scc[0]
      if ((edges.get(v) ?? []).some((e) => e.target === v))
        cycles.push(`${v} → ${v}`)
    }
  }
  return cycles.sort()
}

describe('模块依赖图无环（issue 106，Dependency Design）', () => {
  const edges = buildGraph()
  const runtimeEdges = new Map<string, ModuleEdge[]>()
  for (const [k, list] of edges)
    runtimeEdges.set(
      k,
      list.filter((e) => !e.typeOnly),
    )

  it('运行时图（擦除类型后仍存在的边）无环', () => {
    expect(cyclesOf(runtimeEdges)).toEqual([])
  })

  it('编译期图（含 import type 的反向类型边）无环', () => {
    expect(cyclesOf(edges)).toEqual([])
  })
})
