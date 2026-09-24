import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildSrcExternalEdges,
  buildSrcModuleGraph,
  cyclesOf,
  externalEdgesOfSource,
  modelEditorRuntimeViolations,
  modelFrameworkRuntimeViolations,
  relativeEdgesOfSource,
  type ExternalEdge,
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
 *
 * 模型层纯度守卫（issue #266）：无环是比分层纯度更弱的性质，二者不可
 * 互替——框架运行时依赖禁止与 model → editor 运行时值依赖白名单由
 * 专用判定函数另行检查，判定契约经合成图反例验证（合法依赖不误报）。
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

describe('模型层纯度守卫（issue #266）', () => {
  it('反例：框架包值导入是运行时外边，import type 是编译期外边', () => {
    const edges = externalEdgesOfSource(
      "import { Edge } from '@xyflow/react'\n" +
        "import type { Viewport } from '@xyflow/react'\n" +
        "import { useState } from 'react'",
    )
    expect(edges).toContainEqual({ spec: '@xyflow/react', typeOnly: false })
    expect(edges).toContainEqual({ spec: '@xyflow/react', typeOnly: true })
    expect(edges).toContainEqual({ spec: 'react', typeOnly: false })
  })

  it('反例：框架运行时依赖与 editor 值依赖越界被守卫识别，合法依赖不误报', () => {
    const external = new Map<string, ExternalEdge[]>([
      ['model/x.ts', [{ spec: '@xyflow/react', typeOnly: false }]],
      ['model/ok.ts', [{ spec: '@xyflow/react', typeOnly: true }]],
      // editor 值导入 react 是组件层的正常形态，不在模型守卫范围
      ['editor/x.tsx', [{ spec: 'react', typeOnly: false }]],
    ])
    expect(modelFrameworkRuntimeViolations(external)).toEqual([
      'model/x.ts → @xyflow/react',
    ])

    const graph = new Map<string, ModuleEdge[]>([
      [
        'model/a.ts',
        [
          // 登记的纯叶子值依赖与任意 type-only 依赖均合法
          { target: 'editor/graphRules.ts', typeOnly: false },
          { target: 'editor/settings.ts', typeOnly: false },
          { target: 'editor/nodes/types.ts', typeOnly: true },
          { target: 'editor/SomePanel.tsx', typeOnly: false },
        ],
      ],
      // editor → model 是正常依赖方向，不受限
      ['editor/b.tsx', [{ target: 'model/document.ts', typeOnly: false }]],
    ])
    expect(modelEditorRuntimeViolations(graph)).toEqual([
      'model/a.ts → editor/SomePanel.tsx',
    ])
  })

  it('src/model 生产模块无框架运行时依赖（框架类型仅 import type）', () => {
    expect(
      modelFrameworkRuntimeViolations(buildSrcExternalEdges(SRC_ROOT)),
    ).toEqual([])
  })

  it('src/model → editor 的运行时值依赖限于登记的纯叶子规则', () => {
    expect(modelEditorRuntimeViolations(buildSrcModuleGraph(SRC_ROOT))).toEqual(
      [],
    )
  })
})
