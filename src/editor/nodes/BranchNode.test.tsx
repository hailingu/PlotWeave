// @vitest-environment happy-dom
/**
 * 分支节点（岔路路标）渲染测试：问句即名称、选项条逐条渲染。
 * ⚙️ 面板开关、问句改名与每选项独立出口端口等外壳共享行为收敛至
 * nodeChrome.test.tsx 参数化维护（issue #534）；Handle 桩与
 * NodeEditApi 夹具见 testScaffolding.tsx。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { NodeEditContext } from '../nodeEdit'
import { makeNodeEditApi } from './testScaffolding'
import { BranchNode } from './BranchNode'
import type { BranchFlowNode } from './types'

vi.mock('@xyflow/react', async (importOriginal) =>
  (await import('./testScaffolding')).stubReactFlowHandleModule(
    await importOriginal<typeof import('@xyflow/react')>(),
  ),
)

afterEach(cleanup)

function setup(openSettingsId: string | null = null) {
  const api = makeNodeEditApi({ openSettingsId })
  const props = {
    id: 'br1',
    data: {
      prompt: '林晚是否发现真相？',
      options: [
        { id: 'o1', label: '坦白' },
        { id: 'o2', label: '隐瞒' },
      ],
    },
    selected: false,
  } as unknown as NodeProps<BranchFlowNode>
  render(
    <ReactFlowProvider>
      <NodeEditContext.Provider value={api}>
        <BranchNode {...props} />
      </NodeEditContext.Provider>
    </ReactFlowProvider>,
  )
  return { api }
}

describe('BranchNode（岔路路标）', () => {
  it('问句 + 选项条逐条渲染', () => {
    setup()
    expect(screen.getByText('林晚是否发现真相？')).toBeTruthy()
    expect(screen.getByText('坦白')).toBeTruthy()
    expect(screen.getByText('隐瞒')).toBeTruthy()
  })
})
