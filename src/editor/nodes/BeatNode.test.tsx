// @vitest-environment happy-dom
/**
 * 节奏卡（节拍胶囊）渲染测试：名称/基调、兑现状态徽标（待兑现虚线态 /
 * ✓ 兑现态，派生自 beatFulfillmentOf）、⚙️ 面板开关与内联改名。
 * Handle 依赖 React Flow 仓库上下文，隔离渲染时以锚点桩替代。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { NodeProps } from '@xyflow/react'
import { NodeEditContext, type NodeEditApi } from '../nodeEdit'
import type { BeatFulfillment } from '../outline'
import BeatNode from './BeatNode'
import type { BeatFlowNode } from './types'

vi.mock('@xyflow/react', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...orig,
    /** Handle 桩：脱离 ReactFlow 画布后仅保留锚点语义（type/id）供断言。 */
    Handle: (props: { readonly id?: string; readonly type: string }) => (
      <div data-testid={`handle-${props.type}${props.id ? `-${props.id}` : ''}`} />
    ),
  }
})

afterEach(cleanup)

function setup(fulfillment: BeatFulfillment | null = null) {
  const api: NodeEditApi = {
    openSettingsId: null,
    toggleSettings: vi.fn(),
    closeSettings: vi.fn(),
    patchNode: vi.fn(),
    duplicateNode: vi.fn(),
    deleteNode: vi.fn(),
    shotCountOf: () => 0,
    beatFulfillmentOf: () => fulfillment,
    settings: { characters: [], locations: [] },
    assets: undefined,
  }
  const props = {
    id: 'b1',
    data: { name: '真相逼近', tone: '紧张' },
    selected: false,
  } as unknown as NodeProps<BeatFlowNode>
  const { container } = render(
    <NodeEditContext.Provider value={api}>
      <BeatNode {...props} />
    </NodeEditContext.Provider>,
  )
  return { api, container }
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
    expect(container.querySelector('.pw-beat')?.className).toContain('pw-beat-pending')
  })

  it('已兑现：✓ 徽标，title 标注承载场景', () => {
    const { container } = setup({ status: 'fulfilled', sceneLabel: '场 03 · 天台对峙' })
    const badge = container.querySelector('.pw-beat-state.ok')
    expect(badge?.getAttribute('title')).toContain('场 03 · 天台对峙')
  })

  it('⚙️ 点击 toggleSettings；名称双击改名 → patchNode', () => {
    const { api } = setup()
    fireEvent.click(screen.getByRole('button', { name: '节奏卡设置' }))
    expect(api.toggleSettings).toHaveBeenCalledWith('b1')

    fireEvent.doubleClick(screen.getByRole('button', { name: '真相逼近' }))
    const input = screen.getByRole('textbox', { name: '节奏卡内容' })
    fireEvent.change(input, { target: { value: '雨夜反转' } })
    fireEvent.blur(input)
    expect(api.patchNode).toHaveBeenCalledWith('b1', { name: '雨夜反转' })
  })
})
