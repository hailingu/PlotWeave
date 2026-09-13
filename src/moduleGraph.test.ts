import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildSrcModuleGraph,
  cyclesOf,
  relativeEdgesOfSource,
  type ModuleEdge,
} from './moduleGraph'

/**
 * 模块依赖图的回归守卫（issue 106）：用 src/moduleGraph.ts 构建全仓
 * 非测试模块的依赖图，断言无环——与 issue 106 的基线审计同口径。
 *
 * 依据 docs/development/software-engineering-standard.md「Dependency
 * Design」：维护模块之间禁止循环依赖，解环靠明确归属、抽取稳定契约，
 * 不靠宽化类型或忽略规则。编译期图（含 import type 的擦除前边）与运行
 * 时图（擦除类型后仍存在的边）分别断言：类型反向边造成的环同样算环，
 * 而运行时图无环是既有边界，回归时一并守住。
 *
 * 边采集的语法形态覆盖（PR #116 评审 4000329365）由夹具单测直接验证：
 * import('…').Type 类型查询在 AST 中是 ImportTypeNode 而非
 * CallExpression，漏采会让反向类型环对编译期断言隐形。
 */

/** src 根目录：测试文件位于 src/ 下，直接锚定自身位置。 */
const SRC_ROOT = fileURLToPath(new URL('./', import.meta.url))

describe('相对边采集的语法形态覆盖（PR #116 评审 4000329365）', () => {
  it("import type 查询 import('./x').Foo 记录为编译期边", () => {
    const edges = relativeEdgesOfSource(
      "type C = import('./history').HistoryCommand",
    )
    expect(edges).toEqual([{ spec: './history', typeOnly: true }])
  })

  it("typeof import('./y') 类型查询同样记录为编译期边", () => {
    const edges = relativeEdgesOfSource("type M = typeof import('./lazy')")
    expect(edges).toEqual([{ spec: './lazy', typeOnly: true }])
  })

  it("动态 import('./z') 记录为运行时边", () => {
    const edges = relativeEdgesOfSource("const m = import('./lazy')")
    expect(edges).toEqual([{ spec: './lazy', typeOnly: false }])
  })

  it('import type 整体导入为编译期边；值导入为运行时边', () => {
    const edges = relativeEdgesOfSource(
      "import type { A } from './a'\nimport { b } from './b'",
    )
    expect(edges).toEqual([
      { spec: './a', typeOnly: true },
      { spec: './b', typeOnly: false },
    ])
  })

  it('re-export 为运行时边；export type from 为编译期边', () => {
    const edges = relativeEdgesOfSource(
      "export { validate } from './impl'\nexport type { Shape } from './types'",
    )
    expect(edges).toEqual([
      { spec: './impl', typeOnly: false },
      { spec: './types', typeOnly: true },
    ])
  })

  it('外部包说明符不进入边集；副作用资源导入保留给解析层分类', () => {
    const edges = relativeEdgesOfSource(
      "import { ts } from 'typescript'\nimport './a.css'",
    )
    expect(edges).toEqual([{ spec: './a.css', typeOnly: false }])
  })
})

describe('模块依赖图无环（issue 106，Dependency Design）', () => {
  const edges: Map<string, ModuleEdge[]> = buildSrcModuleGraph(SRC_ROOT)
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
