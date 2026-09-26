import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  buildSrcExternalEdges,
  buildSrcModuleGraph,
  cyclesOf,
  externalEdgesOfSource,
  modelCompileTimeInversionViolations,
  modelEditorRuntimeViolations,
  modelFrameworkRuntimeViolations,
  modelRuntimeClosure,
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
 * 模型层纯度守卫（issue #266、issue #353）：无环是比分层纯度更弱的性质，
 * 二者不可互替——框架运行时依赖禁止、model → editor 运行时值依赖禁止
 * （#353 方向一后原登记纯叶子白名单已随模型层类型自有化移除）与模型层
 * 编译期独立性由专用判定函数另行检查，判定契约经合成图反例验证（合法
 * 依赖不误报）。
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
      // editor 值导入 react 是组件层的正常形态，不在模型闭包内即不标记
      ['editor/x.tsx', [{ spec: 'react', typeOnly: false }]],
    ])
    const graph = new Map<string, ModuleEdge[]>([
      // 无运行时出边：model 根闭包只含自身
      ['model/x.ts', []],
      ['model/ok.ts', []],
      ['editor/x.tsx', []],
    ])
    expect(modelFrameworkRuntimeViolations(graph, external)).toEqual([
      'model/x.ts → @xyflow/react',
    ])

    const layered = new Map<string, ModuleEdge[]>([
      [
        'model/a.ts',
        [
          // type-only 依赖合法（编译期擦除）；任何 editor 值依赖均越界
          // （issue #353 方向一后白名单已移除，graphRules/settings 同论）
          { target: 'editor/nodes/types.ts', typeOnly: true },
          { target: 'editor/SomePanel.tsx', typeOnly: false },
        ],
      ],
      // editor → model 是正常依赖方向，不受限
      ['editor/b.tsx', [{ target: 'model/document.ts', typeOnly: false }]],
    ])
    expect(modelEditorRuntimeViolations(layered)).toEqual([
      'model/a.ts → editor/SomePanel.tsx',
    ])
  })

  it('src/model 生产模块无框架运行时依赖（框架类型仅 import type）', () => {
    expect(
      modelFrameworkRuntimeViolations(
        buildSrcModuleGraph(SRC_ROOT),
        buildSrcExternalEdges(SRC_ROOT),
      ),
    ).toEqual([])
  })

  it('src/model 运行时闭包无 editor 值依赖（issue #353 后无白名单）', () => {
    expect(modelEditorRuntimeViolations(buildSrcModuleGraph(SRC_ROOT))).toEqual(
      [],
    )
  })
})

describe('模型层纯度守卫的边界完整性（PR #305 评审）', () => {
  it('反例：逐说明符 type-only（import { type Edge }）整条边为编译期，混合值绑定仍为运行时边', () => {
    const allType = externalEdgesOfSource(
      "import { type Edge } from '@xyflow/react'",
    )
    expect(allType).toEqual([{ spec: '@xyflow/react', typeOnly: true }])

    const mixed = externalEdgesOfSource(
      "import { type Edge, applyNodeChanges } from '@xyflow/react'",
    )
    expect(mixed).toEqual([{ spec: '@xyflow/react', typeOnly: false }])

    const reexport = relativeEdgesOfSource("export { type Shape } from './t'")
    expect(reexport).toEqual([{ spec: './t', typeOnly: true }])
  })

  it('反例：JSX 隐式引入 react/jsx-runtime 运行时边（jsx: react-jsx），计入守卫①', () => {
    const withJsx = externalEdgesOfSource(
      'export const A = () => <div />',
      ts.ScriptKind.TSX,
    )
    expect(withJsx).toContainEqual({
      spec: 'react/jsx-runtime',
      typeOnly: false,
    })
    const noJsx = externalEdgesOfSource('export const A = 1', ts.ScriptKind.TSX)
    expect(noJsx.some((e) => e.spec.startsWith('react/'))).toBe(false)

    const synthetic = new Map<string, ExternalEdge[]>([
      ['model/x.tsx', [{ spec: 'react/jsx-runtime', typeOnly: false }]],
    ])
    const graph = new Map<string, ModuleEdge[]>([['model/x.tsx', []]])
    expect(modelFrameworkRuntimeViolations(graph, synthetic)).toEqual([
      'model/x.tsx → react/jsx-runtime',
    ])
  })

  it('真图：模型层无 JSX/框架运行时依赖', () => {
    expect(
      modelFrameworkRuntimeViolations(
        buildSrcModuleGraph(SRC_ROOT),
        buildSrcExternalEdges(SRC_ROOT),
      ),
    ).toEqual([])
  })
})

describe('模型层编译期独立性（issue #353，方向一）', () => {
  /** model 是落盘 schema 的所有者：闭包内对 editor/ 的任何编译期边
   * （类型或运行时）与对 @xyflow/* 的任何编译期边都是类型所有权倒置
   * ——编辑器节点形状变更不得等价于持久化 schema 变更。 */
  it('反例：editor/ 类型边、@xyflow 类型边被识别；合法依赖与 editor→model 不误报', () => {
    const graph = new Map<string, ModuleEdge[]>([
      [
        'model/a.ts',
        [
          { target: 'editor/nodes/types.ts', typeOnly: true },
          { target: 'shared.ts', typeOnly: false },
        ],
      ],
      // 经共享叶子的传递类型边同论（闭包口径）
      ['shared.ts', [{ target: 'editor/settings.ts', typeOnly: true }]],
      // editor → model 是正常依赖方向
      ['editor/b.tsx', [{ target: 'model/session.ts', typeOnly: false }]],
    ])
    const external = new Map<string, ExternalEdge[]>([
      [
        'model/a.ts',
        [
          { spec: '@xyflow/react', typeOnly: true },
          // react 类型依赖不在本守卫口径（框架运行时由守卫①另行约束）
          { spec: 'react', typeOnly: true },
        ],
      ],
      ['shared.ts', [{ spec: 'lodash', typeOnly: false }]],
      ['editor/b.tsx', [{ spec: '@xyflow/react', typeOnly: false }]],
    ])
    expect(modelCompileTimeInversionViolations(graph, external)).toEqual([
      'model/a.ts → editor/nodes/types.ts',
      'model/a.ts → @xyflow/react',
      'shared.ts → editor/settings.ts',
    ])
  })

  it('真图：model 闭包无 editor/ 编译期边、无 @xyflow 编译期边', () => {
    expect(
      modelCompileTimeInversionViolations(
        buildSrcModuleGraph(SRC_ROOT),
        buildSrcExternalEdges(SRC_ROOT),
      ),
    ).toEqual([])
  })
})

describe('模型层运行时闭包（PR #305 二轮评审）', () => {
  it('闭包含共享叶子，不含 editor 纯叶子与不可达的组件层（issue #353 后 model 无 editor 依赖）', () => {
    const closure = modelRuntimeClosure(buildSrcModuleGraph(SRC_ROOT))
    // 评审引用的具体传递路径：model/normalize*.ts → src/uid.ts（运行时边）
    expect(closure.has('uid.ts')).toBe(true)
    // issue #353 方向一：model 改为自有 graphSemantics/settings，白名单
    // 叶子不再是 model 的依赖，闭包不含任何 editor 模块
    expect(closure.has('editor/graphRules.ts')).toBe(false)
    expect(closure.has('editor/settings.ts')).toBe(false)
    // 组件层不可达：editor 面板/视图不在 model 运行时闭包内
    expect([...closure].some((k) => k.startsWith('editor/'))).toBe(false)
    expect(closure.has('home/HomePage.tsx')).toBe(false)
  })

  it('反例：闭包内共享叶子的框架运行时边被识别，不可达组件不误报', () => {
    const graph = new Map<string, ModuleEdge[]>([
      ['model/a.ts', [{ target: 'shared.ts', typeOnly: false }]],
      ['shared.ts', [{ target: 'deeper.ts', typeOnly: false }]],
      ['deeper.ts', []],
      // 不可达组件：其 react 运行时边不在闭包口径内
      ['editor/SomePanel.tsx', []],
    ])
    const external = new Map<string, ExternalEdge[]>([
      ['shared.ts', [{ spec: 'react', typeOnly: false }]],
      ['deeper.ts', [{ spec: '@xyflow/react', typeOnly: true }]],
      ['editor/SomePanel.tsx', [{ spec: 'react', typeOnly: false }]],
    ])
    expect(modelFrameworkRuntimeViolations(graph, external)).toEqual([
      'shared.ts → react',
    ])
  })
})

describe('静态模板字面量与闭包 editor 越界（PR #305 三轮评审）', () => {
  it('反例：无替换模板字面量动态导入计入边集', () => {
    const external = externalEdgesOfSource('const m = import(`react`)')
    expect(external).toEqual([{ spec: 'react', typeOnly: false }])
    const relative = relativeEdgesOfSource('const m = import(`./lazy`)')
    expect(relative).toEqual([{ spec: './lazy', typeOnly: false }])
  })

  it('反例：经共享模块间接触达非白名单 editor 模块被识别（闭包口径）', () => {
    const graph = new Map<string, ModuleEdge[]>([
      ['model/a.ts', [{ target: 'shared.ts', typeOnly: false }]],
      ['shared.ts', [{ target: 'editor/SomePanel.tsx', typeOnly: false }]],
    ])
    expect(modelEditorRuntimeViolations(graph)).toEqual([
      'shared.ts → editor/SomePanel.tsx',
    ])
  })
})

describe('动态不可解析导入的 fail-closed（PR #305 四轮评审）', () => {
  it('带替换模板的动态导入采集为 dynamic 边（相对与外部），不进环构图', () => {
    const relative = relativeEdgesOfSource('const m = import(`./x/${n}`)')
    expect(relative).toEqual([
      { spec: './x/${n}', typeOnly: false, dynamic: true },
    ])
    const external = externalEdgesOfSource('const m = import(`pkg-${n}`)')
    expect(external).toEqual([
      { spec: 'pkg-${n}', typeOnly: false, dynamic: true },
    ])
    // 环构图只收可静态定目标的边：dynamic 边不参与（fixture 路径无法解析）
    const edges = buildSrcModuleGraph(SRC_ROOT)
    expect(cyclesOf(edges)).toEqual([])
  })

  it('守卫②：闭包内相对动态导入视为违规（运行时可达任意模块，纯度不可静态验证）', () => {
    const graph = new Map<string, ModuleEdge[]>([
      ['model/a.ts', [{ target: 'shared.ts', typeOnly: false }]],
      [
        'shared.ts',
        [
          { target: './x/${n}', typeOnly: false, dynamic: true },
          // issue #353 后白名单移除：editor 值依赖（原登记叶子同论）一并违规
          { target: 'editor/graphRules.ts', typeOnly: false },
        ],
      ],
    ])
    expect(modelEditorRuntimeViolations(graph)).toEqual([
      'shared.ts → 动态导入（不可静态解析）：./x/${n}',
      'shared.ts → editor/graphRules.ts',
    ])
  })

  it('守卫①：闭包内外部动态导入视为违规（目标包运行时才定）', () => {
    const graph = new Map<string, ModuleEdge[]>([['model/a.ts', []]])
    const external = new Map<string, ExternalEdge[]>([
      ['model/a.ts', [{ spec: 'pkg-${n}', typeOnly: false, dynamic: true }]],
    ])
    expect(modelFrameworkRuntimeViolations(graph, external)).toEqual([
      'model/a.ts → 动态导入（不可静态解析）：pkg-${n}',
    ])
  })

  it('真图：无动态不可解析导入，两守卫维持全空', () => {
    const graph = buildSrcModuleGraph(SRC_ROOT)
    const external = buildSrcExternalEdges(SRC_ROOT)
    expect(modelEditorRuntimeViolations(graph)).toEqual([])
    expect(modelFrameworkRuntimeViolations(graph, external)).toEqual([])
  })
})
