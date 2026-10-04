// @vitest-environment happy-dom
/** 真实编辑器 JSON 导出只读契约（#502）：保存回调、历史栈和输入均保持不变。 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EditorView } from './EditorView'
import { CommandStack } from './history'
import type { EditorProjectContent } from './useEditorDocument'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** 用真实创建/撤销入口准备空栈、撤销栈或重做分支，先冲刷合法编辑保存。 */
async function setup(history: 'empty' | 'undo' | 'redo') {
  vi.useFakeTimers()
  const project: EditorProjectContent = {
    id: 'readonly-json',
    name: '只读导出',
    nodes: [],
    edges: [],
    settings: { characters: [], locations: [] },
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-27T12:00:00.000Z',
  }
  const original = structuredClone(project)
  const onSave = vi.fn()
  // 监视真实栈方法且保留执行；UI 的 canUndo/canRedo 另验证实际历史状态。
  const push = vi.spyOn(CommandStack.prototype, 'push')
  const view = render(
    <EditorView
      project={project}
      onSave={onSave}
      onBackHome={() => {}}
      onRenameProject={() => {}}
    />,
  )
  if (history !== 'empty') {
    fireEvent.click(screen.getByLabelText('新增节点'))
    fireEvent.click(screen.getByRole('menuitem', { name: '场景' }))
    expect(push).toHaveBeenCalledTimes(1)
    if (history === 'redo') fireEvent.click(screen.getByLabelText('撤销'))
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  if (history === 'undo') expect(onSave).toHaveBeenCalledTimes(1)
  onSave.mockClear()
  push.mockClear()
  return { project, original, onSave, push, view }
}

/** 经工具栏打开对话框、切到 JSON 并读取真实生成的预览。 */
function openJson() {
  fireEvent.click(screen.getByRole('button', { name: '导出剧本' }))
  fireEvent.change(screen.getByRole('combobox', { name: '导出格式' }), {
    target: { value: 'json' },
  })
  const text = document.querySelector('.pw-export-pre')?.textContent
  if (!text) throw new Error('缺失 JSON 预览')
  return JSON.parse(text)
}

// 导出旁路保存或压入历史命令会失败；已有合法编辑仍必须可撤销/重做。
it.each(['empty', 'undo', 'redo'] as const)(
  '%s 历史状态下打开、生成、重开和卸载导出均不产生写操作',
  async (history) => {
    const { project, original, onSave, push, view } = await setup(history)
    const undo = screen.getByLabelText('撤销') as HTMLButtonElement
    const redo = screen.getByLabelText('重做') as HTMLButtonElement
    expect(undo.disabled).toBe(history !== 'undo')
    expect(redo.disabled).toBe(history !== 'redo')
    const first = openJson()
    expect(
      first.graph.nodes.map((node: { type: string }) => node.type),
    ).toEqual(history === 'undo' ? ['scene'] : [])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    fireEvent.click(screen.getByLabelText('关闭'))
    expect(openJson()).toEqual(first)
    fireEvent.click(screen.getByLabelText('关闭'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(undo.disabled).toBe(history !== 'undo')
    expect(redo.disabled).toBe(history !== 'redo')
    expect(push).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
    expect(project).toEqual(original)
    view.unmount()
    expect(onSave).not.toHaveBeenCalled()
  },
)
