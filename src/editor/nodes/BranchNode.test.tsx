// @vitest-environment happy-dom
/**
 * 分支节点（岔路路标）渲染测试：问句即名称、选项条逐条渲染、
 * 每选项独立出口端口（option-n）、⚙️ 面板开关与问句改名。
 * Handle 依赖 React Flow 仓库上下文，隔离渲染时以锚点桩替代。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { NodeProps } from '@xyflow/react'
import { NodeEditContext, type NodeEditApi } from '../nodeEdit'
import { BRANCH_OPTION_HANDLE_PREFIX } from '../graphRules'
import BranchNode from './BranchNode'
import type { BranchFlowNode } from './types'

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

function setup(openSettingsId: string | null = null) {
  const api: NodeEditApi = {
    openSettingsId,
    toggleSettings: vi.fn(),
    closeSettings: vi.fn(),
    patchNode: vi.fn(),
    duplicateNode: vi.fn(),
    deleteNode: vi.fn(),
    shotCountOf: () => 0,
    beatFulfillmentOf: () => null,
    settings: { characters: [], locations: [] },
    assets: undefined,
  }
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
    <NodeEditContext.Provider value={api}>
      <BranchNode {...props} />
    </NodeEditContext.Provider>,
  )
  return { api }
}

describe('BranchNode（岔路路标）', () => {
  it('问句 + 选项条逐条渲染，每选项右缘独立出口端口 option-<选项 id>', () => {
    setup()
    expect(screen.getByText('林晚是否发现真相？')).toBeTruthy()
    expect(screen.getByText('坦白')).toBeTruthy()
    expect(screen.getByText('隐瞒')).toBeTruthy()
    expect(screen.getByTestId(`handle-source-${BRANCH_OPTION_HANDLE_PREFIX}o1`)).toBeTruthy()
    expect(screen.getByTestId(`handle-source-${BRANCH_OPTION_HANDLE_PREFIX}o2`)).toBeTruthy()
    expect(screen.getByTestId('handle-target')).toBeTruthy()
  })

  it('⚙️ 点击 toggleSettings；openSettingsId 命中时展开设置面板（含添加选项）', () => {
    const { api } = setup()
    fireEvent.click(screen.getByRole('button', { name: '分支设置' }))
    expect(api.toggleSettings).toHaveBeenCalledWith('br1')
    cleanup()

    setup('br1')
    expect(screen.getByRole('button', { name: '＋ 添加选项' })).toBeTruthy()
  })

  it('问句双击内联改名 → patchNode 合并 prompt', () => {
    const { api } = setup()
    fireEvent.doubleClick(screen.getByRole('button', { name: '林晚是否发现真相？' }))
    const input = screen.getByRole('textbox', { name: '分支问句' })
    fireEvent.change(input, { target: { value: '追或不追？' } })
    fireEvent.blur(input)
    expect(api.patchNode).toHaveBeenCalledWith('br1', { prompt: '追或不追？' })
  })
})
