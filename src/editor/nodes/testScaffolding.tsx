import { vi } from 'vitest'
import type { NodeEditApi } from '../nodeEdit'

/**
 * nodes 组件测试的共享脚手架（issue #534）：Handle 桩工厂与 NodeEditApi
 * 构造器原在 8 个测试文件逐字复制，现收敛于此。按 issue #311 的归类
 * 决定与测试同目录放置并登记为测试设施（sonar-project.properties 的
 * 「源码排除 + 测试纳入」组合、vite 覆盖率 exclude，契约由
 * scripts/sonar-test-scope.test.ts 守卫）：不进生产 bundle，仍被
 * Sonar 按测试代码分析；导入者只能是测试文件或测试设施。
 */

/**
 * 以锚点 Handle 桩替换 @xyflow/react 的 Handle（桩内联于工厂：脱离
 * ReactFlow 画布后仅保留锚点语义 type/id 供断言），其余导出保持原样。
 * 各测试文件经 vi.mock 工厂委托本函数——工厂被 Vitest 提升到 import
 * 之前执行，只能引用 vi 与动态 import，不得引用本模块的静态导入绑定：
 *
 * vi.mock('@xyflow/react', async (importOriginal) =>
 *   (await import('./testScaffolding')).stubReactFlowHandleModule(
 *     await importOriginal<typeof import('@xyflow/react')>(),
 *   ),
 * )
 */
export function stubReactFlowHandleModule(
  orig: typeof import('@xyflow/react'),
): typeof import('@xyflow/react') {
  const HandleStub = (props: {
    readonly id?: string
    readonly type: string
  }) => (
    <div
      data-testid={`handle-${props.type}${props.id ? `-${props.id}` : ''}`}
    />
  )
  // 断言必要：真实 Handle 是 memo 包装组件且 props 面更宽，桩有意收窄
  // 到锚点语义（type/id），测试文件只按此形状渲染。
  return {
    ...orig,
    Handle: HandleStub as unknown as typeof orig.Handle,
  }
}

/** NodeEditApi 覆盖项：只写差异字段，缺省形状由 makeNodeEditApi 补齐。 */
export type NodeEditApiOverrides = {
  readonly [K in keyof NodeEditApi]?: NodeEditApi[K]
}

/**
 * 构造隔离渲染用的 NodeEditApi：写方法为 vi.fn()、派生查询返回空值、
 * 设定集为空投影——即原 8 处字面量的公共形状；差异经 overrides 逐项
 * 覆盖（openSettingsId / settings / assets / shotCountOf 等）。
 */
export function makeNodeEditApi(
  overrides: NodeEditApiOverrides = {},
): NodeEditApi {
  return {
    projectId: 'p-1',
    openSettingsId: null,
    toggleSettings: vi.fn(),
    closeSettings: vi.fn(),
    patchNode: vi.fn(),
    duplicateNode: vi.fn(),
    deleteNode: vi.fn(),
    shotCountOf: () => 0,
    beatFulfillmentOf: () => null,
    settings: { characters: [], locations: [] },
    assets: undefined,
    ...overrides,
  }
}
