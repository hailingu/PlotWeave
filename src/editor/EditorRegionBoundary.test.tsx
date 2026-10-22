// @vitest-environment happy-dom
/** 项目切换恢复与无 DOM 包装的边界契约，不重放失败子树的动作。 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EditorRegionBoundary } from './EditorRegionBoundary'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** 条件故障由上层输入驱动，模拟项目内容切换。 */
function Content({ fail }: { readonly fail: boolean }) {
  if (fail) throw new Error('project render failure')
  return <p>项目内容</p>
}

it('失败只在显式重试或项目身份切换后恢复，同项目普通更新不自动重试', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const content = (projectId: string, fail: boolean) => (
    <EditorRegionBoundary projectId={projectId} region="canvas">
      <Content fail={fail} />
    </EditorRegionBoundary>
  )
  const view = render(content('one', false))
  expect(view.container.firstElementChild).toBe(screen.getByText('项目内容'))
  view.rerender(content('one', true))
  expect(screen.getByRole('alert').textContent).toContain('画布暂时不可用')
  view.rerender(content('one', false))
  expect(screen.queryByText('项目内容')).toBeNull()
  view.rerender(content('two', false))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(view.container.firstElementChild).toBe(screen.getByText('项目内容'))
})
