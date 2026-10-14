// @vitest-environment happy-dom
/**
 * 节奏卡（节拍胶囊）渲染测试：名称/基调、兑现状态徽标（待兑现虚线态 /
 * ✓ 兑现态，派生自 beatFulfillmentOf）。
 * ⚙️ 面板开关与内联改名等外壳共享行为收敛至 nodeChrome.test.tsx
 * 参数化维护（issue #534）；Handle 桩与 NodeEditApi 夹具见
 * testScaffolding.tsx。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { NodeEditContext } from '../nodeEdit'
import type { BeatFulfillment } from '../outline'
import { makeNodeEditApi } from './testScaffolding'
import { BeatNode } from './BeatNode'
import type { BeatFlowNode } from './types'

vi.mock('@xyflow/react', async (importOriginal) =>
  (await import('./testScaffolding')).stubReactFlowHandleModule(
    await importOriginal<typeof import('@xyflow/react')>(),
  ),
)

afterEach(cleanup)

function setup(fulfillment: BeatFulfillment | null = null) {
  const api = makeNodeEditApi({ beatFulfillmentOf: () => fulfillment })
  const props = {
    id: 'b1',
    data: { name: '真相逼近', tone: '紧张' },
    selected: false,
  } as unknown as NodeProps<BeatFlowNode>
  const { container } = render(
    <ReactFlowProvider>
      <NodeEditContext.Provider value={api}>
        <BeatNode {...props} />
      </NodeEditContext.Provider>
    </ReactFlowProvider>,
  )
  return { container }
}

describe('BeatNode（节拍胶囊）', () => {
  it('渲染 ⚡ + 名称 + 基调；无兑现信息时不出现状态徽标', () => {
    const { container } = setup()
    expect(screen.getByText('真相逼近')).toBeTruthy()
    expect(screen.getByText('基调：紧张')).toBeTruthy()
    expect(container.querySelector('.pw-beat-state')).toBeNull()
  })

  it('待兑现：虚线态 + 「待兑现」徽标（节奏漏洞提示）', () => {
    const { container } = setup({ status: 'pending' })
    expect(screen.getByText('待兑现')).toBeTruthy()
    expect(container.querySelector('.pw-beat')?.className).toContain(
      'pw-beat-pending',
    )
  })

  it('已兑现：✓ 徽标，title 标注承载场景', () => {
    const { container } = setup({
      status: 'fulfilled',
      sceneLabel: '场 03 · 天台对峙',
    })
    const badge = container.querySelector('.pw-beat-state.ok')
    expect(badge?.getAttribute('title')).toContain('场 03 · 天台对峙')
  })
})
