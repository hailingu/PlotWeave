// @vitest-environment happy-dom
/**
 * 对白节点（气泡流卡）渲染测试：标题行派生统计、台词气泡/动作行、
 * 头像解析与失效兜底、VO 徽标、设定集投影实时解析。
 * ⚙️ 面板开关、内联改名与左右端口等外壳共享行为收敛至
 * nodeChrome.test.tsx 参数化维护（issue #534）；Handle 桩与
 * NodeEditApi 夹具见 testScaffolding.tsx。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { NodeEditContext } from '../nodeEdit'
import type { ProjectSettings } from '../settings'
import { makeNodeEditApi } from './testScaffolding'
import { DialogueNode } from './DialogueNode'
import type { DialogueFlowNode, DialogueLine } from './types'

vi.mock('@xyflow/react', async (importOriginal) =>
  (await import('./testScaffolding')).stubReactFlowHandleModule(
    await importOriginal<typeof import('@xyflow/react')>(),
  ),
)

afterEach(cleanup)

const SETTINGS: ProjectSettings = {
  characters: [
    { id: 'c1', name: '林晚', gradient: 'linear-gradient(#a700ab, #047ad2)' },
  ],
  locations: [],
}

const LINES: DialogueLine[] = [
  { id: 'l1', kind: 'line', speaker: 'c1', side: 'left', text: '你早就知道' },
  { id: 'l2', kind: 'action', text: '雨声渐大' },
  {
    id: 'l3',
    kind: 'line',
    speaker: 'ghost',
    side: 'right',
    text: '……',
    vo: true,
  },
]

function setup(data: { name?: string; lines?: DialogueLine[] } = {}) {
  const api = makeNodeEditApi({ settings: structuredClone(SETTINGS) })
  const props = {
    id: 'd1',
    data: { name: data.name ?? '真相逼近', lines: data.lines ?? LINES },
    selected: false,
  } as unknown as NodeProps<DialogueFlowNode>
  const { container, rerender } = render(
    <ReactFlowProvider>
      <NodeEditContext.Provider value={api}>
        <DialogueNode {...props} />
      </NodeEditContext.Provider>
    </ReactFlowProvider>,
  )
  /** 模拟设定集投影更新，保留同一对白与说话人引用。 */
  const rerenderSettings = (settings: ProjectSettings) =>
    rerender(
      <ReactFlowProvider>
        <NodeEditContext.Provider value={{ ...api, settings }}>
          <DialogueNode {...props} />
        </NodeEditContext.Provider>
      </ReactFlowProvider>,
    )
  return { container, rerenderSettings }
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

  it('说话人头像：命中设定集渲染中性头像；失效引用 ✕ 并加「已删除角色」前缀', () => {
    const { container } = setup()
    const avatar = container.querySelector('.pw-av-sm:not(.pw-av-invalid)')
    expect(avatar?.textContent).toBe('林')
    expect((avatar as HTMLElement).style.background).toBe('')
    expect(container.querySelector('.pw-av-invalid')?.textContent).toBe('✕')
    expect(screen.getByText('已删除角色：')).toBeTruthy()
  })

  it('人物改名、删除及恢复时，同一说话人引用保持实时解析和失效提示', () => {
    const { container, rerenderSettings } = setup()
    rerenderSettings({
      ...SETTINGS,
      characters: [{ ...SETTINGS.characters[0], name: '顾宁' }],
    })
    expect(container.querySelector('.pw-node-avatar')?.textContent).toBe('顾')
    rerenderSettings({ ...SETTINGS, characters: [] })
    expect(container.querySelectorAll('.pw-av-invalid')).toHaveLength(2)
    expect(screen.getAllByText('已删除角色：')).toHaveLength(2)
    rerenderSettings(SETTINGS)
    expect(container.querySelector('.pw-node-avatar')?.textContent).toBe('林')
    expect(screen.getAllByText('已删除角色：')).toHaveLength(1)
  })

  it('没有说话人的台词不制造人物头像', () => {
    const { container } = setup({
      lines: [
        { id: 'narration', kind: 'line', side: 'left', text: '雨停了。' },
      ],
    })
    expect(screen.getByText('雨停了。')).toBeTruthy()
    expect(container.querySelector('.pw-node-avatar')).toBeNull()
  })
})
