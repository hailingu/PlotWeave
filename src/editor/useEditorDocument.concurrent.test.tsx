// @vitest-environment happy-dom
/** Discarded renders must not publish document mirrors or replace canonical content. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  startTransition,
  StrictMode,
  Suspense,
  useLayoutEffect,
  useState,
} from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRenderGate,
  type RenderGate,
} from './concurrentRenderTestScaffolding'
import {
  useEditorDocument,
  type EditorDocument,
  type EditorProjectContent,
} from './useEditorDocument'
import type { CanvasNode } from './nodes/types'

afterEach(cleanup)

const NODE: CanvasNode = {
  id: 'beat',
  type: 'beat',
  position: { x: 0, y: 0 },
  data: { name: 'committed', tone: '' },
}
const PROJECT: EditorProjectContent = {
  id: 'p',
  name: 'concurrent',
  nodes: [NODE],
  edges: [],
  settings: { characters: [], locations: [] },
}
const MOVED: CanvasNode[] = [{ ...NODE, position: { x: 100, y: 0 } }]
const DRAFT: CanvasNode[] = [{ ...NODE, data: { ...NODE.data, name: 'draft' } }]

/** Capture only committed values; a test probe must not itself leak draft output. */
function DocumentHost({
  gate,
  onCommit,
}: {
  gate: RenderGate
  onCommit: (doc: EditorDocument) => void
}) {
  const doc = useEditorDocument(PROJECT)
  const [pulse, setPulse] = useState(0)
  const first = doc.nodes[0]
  const name = first?.type === 'beat' ? first.data.name : ''
  useLayoutEffect(() => {
    onCommit(doc)
  }, [doc, onCommit])
  const Gate = gate.Component
  return (
    <>
      {name === 'draft' && <Gate />}
      <output data-testid="document">{name}</output>
      <output data-testid="pulse">{pulse}</output>
      <button
        onClick={() => {
          doc.setNodes(MOVED)
          setPulse((value) => value + 1)
        }}
      >
        restore committed
      </button>
    </>
  )
}

/** A real concurrent root keeps the old tree visible while its replacement loads. */
function mountDocument(strict: boolean) {
  const gate = createRenderGate()
  let committed: EditorDocument | undefined
  const onCommit = (doc: EditorDocument) => {
    committed = doc
  }
  const body = (
    <Suspense fallback={<p>loading</p>}>
      <DocumentHost gate={gate} onCommit={onCommit} />
    </Suspense>
  )
  const view = render(strict ? <StrictMode>{body}</StrictMode> : body)
  return {
    view,
    gate,
    doc: () => {
      if (!committed) throw new Error('Document has not committed')
      return committed
    },
    close: async () => {
      await act(async () => {
        view.unmount()
        gate.release()
      })
    },
  }
}

describe('document commit observations', () => {
  it.each([false, true])(
    'publishes mirrors only with the visible tree (StrictMode=%s)',
    async (strict) => {
      const fixture = mountDocument(strict)
      const original = fixture.doc()
      try {
        await act(async () => {
          startTransition(() => original.setNodes(DRAFT))
        })
        expect(fixture.gate.wasRequested()).toBe(true)
        expect(screen.getByTestId('document').textContent).toBe('committed')
        expect(original.nodesRef.current).toBe(PROJECT.nodes)
        await act(async () => {
          fixture.gate.release()
        })
        expect(screen.getByTestId('document').textContent).toBe('draft')
        expect(fixture.doc().nodesRef.current).toBe(DRAFT)
      } finally {
        await fixture.close()
      }
    },
  )

  it.each([false, true])(
    'preserves canonical content after a discarded edit following a drag (StrictMode=%s)',
    async (strict) => {
      const fixture = mountDocument(strict)
      const canonical = fixture.doc().contentNodes
      try {
        act(() => {
          fixture.doc().setNodes(MOVED)
        })
        expect(fixture.doc().contentNodes).toBe(canonical)
        await act(async () => {
          startTransition(() => fixture.doc().setNodes(DRAFT))
        })
        expect(fixture.gate.wasRequested()).toBe(true)
        expect(screen.getByTestId('document').textContent).toBe('committed')
        fireEvent.click(
          screen.getByRole('button', { name: 'restore committed' }),
        )
        expect(screen.getByTestId('pulse').textContent).toBe('1')
        expect(screen.getByTestId('document').textContent).toBe('committed')
        expect(fixture.doc().contentNodes).toBe(canonical)
      } finally {
        await fixture.close()
      }
    },
  )

  it('retains immediate imperative mirror writes within a StrictMode burst', async () => {
    const fixture = mountDocument(true)
    try {
      act(() => {
        const doc = fixture.doc()
        doc.nodesRef.current = MOVED
        doc.setNodes(MOVED)
        expect(doc.nodesRef.current).toBe(MOVED)
        const next = [{ ...NODE, position: { x: 200, y: 0 } }]
        doc.nodesRef.current = next
        doc.setNodes(next)
        expect(doc.nodesRef.current).toBe(next)
      })
      expect(fixture.doc().nodesRef.current).toBe(fixture.doc().nodes)
      expect(fixture.doc().nodes[0]?.position.x).toBe(200)
    } finally {
      await fixture.close()
    }
  })
})
