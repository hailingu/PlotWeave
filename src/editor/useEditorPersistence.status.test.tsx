// @vitest-environment happy-dom
/** #619：只投影真实保存 owner 的状态，旧完成与外部重存不能提前确认新编辑。 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useEditorDocument } from './useEditorDocument'
import { useEditorPersistence } from './useEditorPersistence'
import { useDebouncedSave } from './useDebouncedSave'
import { notifyRetryPersisted } from '../projectStore/saveChain'
import type { ProjectContent } from '../model/content'

const project = {
  id: 'status-project',
  name: '保存状态',
  nodes: [],
  edges: [],
  settings: { characters: [], locations: [] },
}
beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  await act(async () => cleanup())
  vi.useRealTimers()
})

/** 组装真实文档与保存 owner；视口入口同步标脏并推进文档引用。 */
function setup() {
  const onSave = vi.fn<(doc: ProjectContent) => void | Promise<void>>()
  const view = renderHook(() => {
    const doc = useEditorDocument(project)
    return useEditorPersistence(project, doc, onSave)
  })
  const edit = (x: number) =>
    act(() => view.result.current.onMoveEnd(null, { x, y: 0, zoom: 1 }))
  const advance = (ms = 600) => act(async () => vi.advanceTimersByTimeAsync(ms))
  return { ...view, onSave, edit, advance }
}

it('首开只显示已载入，防抖期和 Promise 在途均为 saving，落定后才 saved', async () => {
  const { result, onSave, edit, advance } = setup()
  let finish!: () => void
  onSave.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  expect(result.current.saveStatus).toBe('idle')
  await advance()
  expect(onSave).not.toHaveBeenCalled()
  edit(10)
  expect(result.current.saveStatus).toBe('saving')
  await advance(599)
  expect(onSave).not.toHaveBeenCalled()
  expect(result.current.saveStatus).toBe('saving')
  await advance(1)
  expect(onSave).toHaveBeenCalledTimes(1)
  expect(result.current.saveStatus).toBe('saving')
  await act(async () => finish())
  expect(result.current.saveStatus).toBe('saved')
})

it('旧保存 A 完成时新编辑 B 仍在途，B 真正落盘才 saved', async () => {
  const { result, onSave, edit, advance } = setup()
  let finishA!: () => void
  let finishB!: () => void
  onSave
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishA = resolve
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishB = resolve
        }),
    )
  edit(10)
  await advance()
  edit(20)
  await act(async () => finishA())
  expect(onSave).toHaveBeenCalledTimes(2)
  expect(result.current.saveStatus).toBe('saving')
  expect(onSave.mock.calls[1]?.[0].viewport?.x).toBe(20)
  await act(async () => finishB())
  expect(result.current.saveStatus).toBe('saved')
})

it('失败态保留错误和重试，重试真正成功后 saved', async () => {
  const { result, onSave, edit, advance } = setup()
  let finish!: () => void
  onSave.mockRejectedValueOnce(new Error('磁盘满')).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  edit(10)
  await advance()
  expect(result.current.saveStatus).toBe('failed')
  expect(result.current.saveError).toBe('磁盘满')
  await advance()
  expect(result.current.saveStatus).toBe('saving')
  await act(async () => finish())
  expect(result.current.saveStatus).toBe('saved')
  expect(result.current.saveError).toBeNull()
})

it.each([false, true])(
  '链上重存确认仅覆盖原编辑，更新编辑=%s',
  async (newEdit) => {
    const { result, onSave, edit, advance } = setup()
    onSave.mockRejectedValueOnce(new Error('暂不可写'))
    edit(10)
    await advance()
    const failed = onSave.mock.calls[0]![0]
    if (newEdit) edit(20)
    act(() => notifyRetryPersisted(failed))
    expect(result.current.saveStatus).toBe(newEdit ? 'saving' : 'saved')
    if (newEdit) {
      await advance()
      expect(result.current.saveStatus).toBe('saved')
      expect(onSave.mock.calls[1]?.[0].viewport?.x).toBe(20)
    }
  },
)

it('新签名的渲染在 passive effect 之前也不能沿用旧 saved', async () => {
  const renders: Array<{ name: string; status: string }> = []
  const onSave = vi.fn()
  const { result, rerender } = renderHook(
    ({ name }: { name: string }) => {
      const saving = useDebouncedSave({ ...project, name }, onSave)
      renders.push({ name, status: saving.saveStatus })
      return saving
    },
    { initialProps: { name: 'A' } },
  )
  rerender({ name: 'B' })
  await act(async () => vi.advanceTimersByTimeAsync(600))
  expect(result.current.saveStatus).toBe('saved')
  renders.length = 0
  rerender({ name: 'C' })
  expect(renders.length).toBeGreaterThan(0)
  expect(
    renders.every((frame) => frame.name === 'C' && frame.status === 'saving'),
  ).toBe(true)
})
