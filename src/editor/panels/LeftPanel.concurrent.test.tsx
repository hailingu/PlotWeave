// @vitest-environment happy-dom
/** An abandoned outline must not evict the committed ordering projection. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  startTransition,
  StrictMode,
  Suspense,
  useLayoutEffect,
  useState,
} from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LeftPanel } from './LeftPanel'
import {
  createRenderGate,
  type RenderGate,
} from '../concurrentRenderTestScaffolding'
import type { CanvasNode } from '../nodes/types'

const builds = vi.hoisted(() => ({ count: 0 }))
vi.mock('../outline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../outline')>()
  return {
    ...actual,
    buildOutlineGroups: (
      ...args: Parameters<typeof actual.buildOutlineGroups>
    ) => {
      builds.count += 1
      return actual.buildOutlineGroups(...args)
    },
  }
})
afterEach(cleanup)

const NODE = {
  id: 'beat',
  type: 'beat',
  position: { x: 0, y: 0 },
  data: { name: 'committed', tone: '' },
} satisfies CanvasNode
const NODES: CanvasNode[] = [NODE]
const MOVED: CanvasNode[] = [{ ...NODE, position: { x: 100, y: 0 } }]
const DRAFT: CanvasNode[] = [{ ...NODE, data: { ...NODE.data, name: 'draft' } }]

/** Only stable fixtures enter the real panel; per-render nodes are varied explicitly. */
function panelProps(): Parameters<typeof LeftPanel>[0] {
  return {
    open: true,
    width: 280,
    onResize: vi.fn(),
    nodes: NODES,
    contentNodes: NODES,
    edges: [],
    episodeTitles: {},
    focusedEpisode: null,
    settings: { characters: [], locations: [] },
    docDialog: { editingDocId: null, open: vi.fn(), close: vi.fn() },
    settingsActions: {
      addCharacter: vi.fn(),
      renameCharacter: vi.fn(),
      deleteCharacter: vi.fn(),
      updateCharacter: vi.fn(),
      addLocation: vi.fn(),
      renameLocation: vi.fn(),
      deleteLocation: vi.fn(),
      updateLocation: vi.fn(),
      addDocument: vi.fn(),
      updateDocument: vi.fn(),
      deleteDocument: vi.fn(),
    },
  }
}

/** The lazy sibling is visited after the real panel has rendered its proposed input. */
function PanelHost({
  gate,
  onCommit,
}: {
  gate: RenderGate
  onCommit: (write: (nodes: CanvasNode[]) => void) => void
}) {
  const [props] = useState(panelProps)
  const [nodes, setNodes] = useState(NODES)
  const [pulse, setPulse] = useState(0)
  useLayoutEffect(() => {
    onCommit(setNodes)
  }, [onCommit])
  const draft = nodes === DRAFT
  const Gate = gate.Component
  return (
    <>
      <LeftPanel
        {...props}
        nodes={nodes}
        contentNodes={draft ? DRAFT : NODES}
      />
      {draft && <Gate />}
      <output data-testid="pulse">{pulse}</output>
      <button
        onClick={() => {
          setNodes(MOVED)
          setPulse((value) => value + 1)
        }}
      >
        restore
      </button>
    </>
  )
}

describe('committed outline projection', () => {
  it.each([false, true])(
    'keeps its cached order after discarding an edit (StrictMode=%s)',
    async (strict) => {
      const gate = createRenderGate()
      let write: (nodes: CanvasNode[]) => void = () => {
        throw new Error('not committed')
      }
      const body = (
        <Suspense fallback={<p>loading</p>}>
          <PanelHost
            gate={gate}
            onCommit={(next) => {
              write = next
            }}
          />
        </Suspense>
      )
      const view = render(strict ? <StrictMode>{body}</StrictMode> : body)
      try {
        await act(async () => {
          write(MOVED)
        })
        await act(async () => {
          startTransition(() => {
            write(DRAFT)
          })
        })
        expect(gate.wasRequested()).toBe(true)
        expect(
          screen.getByRole('button', { name: /committed/ }).textContent,
        ).toContain('committed')
        const attempts = builds.count
        fireEvent.click(screen.getByRole('button', { name: 'restore' }))
        expect(screen.getByTestId('pulse').textContent).toBe('1')
        expect(
          screen.getByRole('button', { name: /committed/ }).textContent,
        ).toContain('committed')
        expect(builds.count).toBe(attempts)
      } finally {
        await act(async () => {
          view.unmount()
          gate.release()
        })
      }
    },
  )
})
