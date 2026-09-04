// @vitest-environment happy-dom
/**
 * 对白节点（气泡流卡）渲染测试：标题行派生统计、台词气泡/动作行、
 * 头像解析与失效兜底、VO 徽标、⚙️ 面板开关与内联改名、左右端口。
 * Handle 依赖 React Flow 仓库上下文，隔离渲染时以锚点桩替代。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { NodeProps } from '@xyflow/react'
import { NodeEditContext, type NodeEditApi } from '../nodeEdit'
import type { ProjectSettings } from '../settings'
import DialogueNode from './DialogueNode'
import type { DialogueFlowNode, DialogueLine } from './types'

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

const SETTINGS: ProjectSettings = {
  characters: [{ id: 'c1', name: '林晚', gradient: 'g1' }],
  locations: [],
}

const LINES: DialogueLine[] = [
  { id: 'l1', kind: 'line', speaker: 'c1', side: 'left', text: '你早就知道' },
  { id: 'l2', kind: 'action', text: '雨声渐大' },
  { id: 'l3', kind: 'line', speaker: 'ghost', side: 'right', text: '……', vo: true },
]

function setup(data: { name?: string; lines?: DialogueLine[] } = {}, openSettingsId: string | null = null) {
  const api: NodeEditApi = {
    projectId: 'p-1',
    openSettingsId,
    toggleSettings: vi.fn(),
    closeSettings: vi.fn(),
    patchNode: vi.fn(),
    duplicateNode: vi.fn(),
    deleteNode: vi.fn(),
    shotCountOf: () => 0,
    beatFulfillmentOf: () => null,
    settings: structuredClone(SETTINGS),
    assets: undefined,
  }
  const props = {
    id: 'd1',
    data: { name: data.name ?? '真相逼近', lines: data.lines ?? LINES },
    selected: false,
  } as unknown as NodeProps<DialogueFlowNode>
  const { container, unmount } = render(
    <NodeEditContext.Provider value={api}>
      <DialogueNode {...props} />
    </NodeEditContext.Provider>,
  )
  return { api, container, unmount }
}

describe('DialogueNode（气泡流卡）', () => {
  it('标题行：名称 + 「n 人 · m 句」派生统计（动作行不计句、失效说话人计人）', () => {
    setup()
    expect(screen.getByText('真相逼近')).toBeTruthy()
    expect(screen.getByText('2 人 · 2 句')).toBeTruthy()
  })

  it('台词气泡分左右；动作行居中斜体；VO 行带徽标', () => {
    const { container } = setup()
    const rows = container.querySelectorAll('.pw-dlg-bubrow')
    expect(rows).toHaveLength(2)
    expect(rows[1].className).toContain('pw-right')
    expect(container.querySelector('.pw-dlg-act')?.textContent).toBe('雨声渐大')
    expect(screen.getByText('VO')).toBeTruthy()
  })

  it('说话人头像：命中设定集渲染渐变头像；失效引用 ✕ 并加「已删除角色」前缀', () => {
    const { container } = setup()
    const avatar = container.querySelector('.pw-av-sm:not(.pw-av-invalid)')
    expect(avatar?.textContent).toBe('林')
    expect(container.querySelector('.pw-av-invalid')?.textContent).toBe('✕')
    expect(screen.getByText('已删除角色：')).toBeTruthy()
  })

  it('⚙️ 点击 toggleSettings 且阻止冒泡；openSettingsId 命中时展开设置面板', () => {
    const { api, unmount } = setup()
    fireEvent.click(screen.getByRole('button', { name: '对白设置' }))
    expect(api.toggleSettings).toHaveBeenCalledWith('d1')
    unmount()

    setup({}, 'd1')
    expect(screen.getByRole('button', { name: '＋ 添加台词' })).toBeTruthy()
  })

  it('名称双击内联改名 → patchNode 合并 name', () => {
    const { api } = setup()
    fireEvent.doubleClick(screen.getByRole('button', { name: '真相逼近' }))
    const input = screen.getByRole('textbox', { name: '对白名称' })
    fireEvent.change(input, { target: { value: '雨夜摊牌' } })
    fireEvent.blur(input)
    expect(api.patchNode).toHaveBeenCalledWith('d1', { name: '雨夜摊牌' })
  })

  it('端口：左入右出', () => {
    setup()
    expect(screen.getByTestId('handle-target')).toBeTruthy()
    expect(screen.getByTestId('handle-source')).toBeTruthy()
  })
})
