// @vitest-environment happy-dom
/** A suspended replacement must not publish global handlers for an unseen tree. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { startTransition, StrictMode, Suspense } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRenderGate,
  type RenderGate,
} from './concurrentRenderTestScaffolding'
import { useEditorHotkeys, type EditorHotkeyActions } from './useEditorHotkeys'

afterEach(cleanup)

/** Deletion targets are observable effects; unrelated actions stay inert. */
function actions(
  id: string,
  remove: EditorHotkeyActions['onDeleteNodes'],
): EditorHotkeyActions {
  return {
    modalEditingOpen: false,
    exportDialogOpen: false,
    selectedNodeIds: () => [id],
    selectedEdgeIds: () => [],
    onDeleteNodes: remove,
    onDeleteEdges: () => undefined,
    onUndo: () => undefined,
    onRedo: () => undefined,
    onEscape: () => undefined,
    onCloseTransient: () => undefined,
  }
}

/** The hook renders before its lazy descendant suspends, matching a real shell. */
function HotkeyHost({
  value,
  blocked,
  gate,
}: {
  value: EditorHotkeyActions
  blocked: boolean
  gate: RenderGate
}) {
  useEditorHotkeys(value)
  const Gate = gate.Component
  return (
    <>
      {blocked && <Gate />}
      <output>{blocked ? 'draft' : 'committed'}</output>
    </>
  )
}

describe('committed global hotkeys', () => {
  it.each([false, true])(
    'keeps the visible deletion target during suspended replacement (StrictMode=%s)',
    async (strict) => {
      const gate = createRenderGate()
      const removeCommitted = vi.fn()
      const removeDraft = vi.fn()
      const committed = actions('visible-node', removeCommitted)
      const draft = actions('unseen-node', removeDraft)
      const tree = (value: EditorHotkeyActions, blocked: boolean) => {
        const body = (
          <Suspense fallback={<p>loading</p>}>
            <HotkeyHost value={value} blocked={blocked} gate={gate} />
          </Suspense>
        )
        return strict ? <StrictMode>{body}</StrictMode> : body
      }
      const view = render(tree(committed, false))
      try {
        await act(async () => {
          startTransition(() => view.rerender(tree(draft, true)))
        })
        expect(gate.wasRequested()).toBe(true)
        expect(screen.getByRole('status').textContent).toBe('committed')
        fireEvent.keyDown(document.body, { key: 'Delete' })
        expect(removeCommitted).toHaveBeenCalledExactlyOnceWith([
          'visible-node',
        ])
        expect(removeDraft).not.toHaveBeenCalled()
        await act(async () => {
          gate.release()
        })
        expect(screen.getByRole('status').textContent).toBe('draft')
        fireEvent.keyDown(document.body, { key: 'Delete' })
        expect(removeDraft).toHaveBeenCalledExactlyOnceWith(['unseen-node'])
      } finally {
        await act(async () => {
          view.unmount()
          gate.release()
        })
      }
    },
  )
})
