// @vitest-environment happy-dom
/** #619：真实编辑器命令、状态区、失败横幅与自动重试消费同一保存链。 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EditorView } from './EditorView'

const project = {
  id: 'status-ui',
  name: '保存状态',
  nodes: [],
  edges: [],
  settings: { characters: [], locations: [] },
}
afterEach(async () => {
  await act(async () => cleanup())
  vi.useRealTimers()
})

it('编辑 → saving → failed → 自动重试 → saved，失败横幅沿用原通道', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  const onSave = vi
    .fn()
    .mockRejectedValueOnce(new Error('磁盘暂不可写'))
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
  render(
    <EditorView
      project={project}
      onSave={onSave}
      onBackHome={vi.fn()}
      onRenameProject={vi.fn()}
    />,
  )
  const status = () => screen.getByRole('status', { name: '画布保存状态' })
  expect(status().textContent).toContain('已载入')
  fireEvent.click(screen.getByLabelText('新增节点'))
  fireEvent.click(screen.getByRole('menuitem', { name: '场景' }))
  expect(status().textContent).toContain('保存中')
  await act(async () => vi.advanceTimersByTimeAsync(600))
  expect(status().textContent).toContain('保存失败')
  expect(screen.getByRole('alert').textContent).toContain('磁盘暂不可写')
  await act(async () => vi.advanceTimersByTimeAsync(600))
  expect(status().textContent).toContain('保存中')
  await act(async () => finish())
  expect(status().textContent).toContain('已保存')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(onSave).toHaveBeenCalledTimes(2)
})
