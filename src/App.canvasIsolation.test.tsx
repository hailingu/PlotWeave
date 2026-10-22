// @vitest-environment happy-dom
/** Real App wiring must keep unrelated project metadata outside the canvas memo boundary. */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import {
  afterAppShellTest,
  homeProps,
  resetAppShellFixture,
  store,
} from './appShellTestScaffolding'

const probe = vi.hoisted(() => ({ executions: 0 }))
vi.mock('./projectStore', async () =>
  (await import('./appShellTestScaffolding')).projectStoreMockModule(),
)
vi.mock('./home/HomePage', async () =>
  (await import('./appShellTestScaffolding')).homePageMockModule(),
)
vi.mock('./editor/EditorCanvasRegion', async () => {
  const { memo } = await import('react')
  return {
    EditorCanvasRegion: memo(function CanvasInputProbe() {
      probe.executions += 1
      return <div data-testid="canvas-input" />
    }),
  }
})

afterEach(afterAppShellTest)
beforeEach(() => {
  resetAppShellFixture()
  probe.executions = 0
  store.save.mockResolvedValue(undefined)
})

describe('App canvas inputs', () => {
  it('updates the real editor title without rerendering canvas inputs', async () => {
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      ;(homeProps.current.onOpenProject as (id: string) => void)('p1')
    })
    await screen.findByTestId('canvas-input')
    const originalExecutions = probe.executions
    expect(originalExecutions).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '雨夜' }))
    const name = screen.getByRole('textbox', { name: '项目名' })
    fireEvent.change(name, { target: { value: 'renamed project' } })
    fireEvent.blur(name)
    expect(
      screen.getByRole('button', { name: 'renamed project' }).textContent,
    ).toBe('renamed project')
    expect(probe.executions).toBe(originalExecutions)

    fireEvent.click(screen.getByLabelText('新增节点'))
    fireEvent.click(screen.getByRole('menuitem', { name: '场景' }))
    expect(probe.executions).toBe(originalExecutions + 1)
  })
})
