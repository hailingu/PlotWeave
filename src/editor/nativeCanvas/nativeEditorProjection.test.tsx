// @vitest-environment happy-dom
/** Real document/controller ownership and native transport guard projection reuse. */
import { act, cleanup, renderHook } from '@testing-library/react'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { startTransition, Suspense, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import * as outline from '../outline'
import { useEditorController } from '../useEditorController'
import type { EditorProjectContent } from '../useEditorDocument'
import type { SceneFlowNode } from '../nodes/types'
import { useNativeEditorShell } from './useNativeEditorShell'

const host = window as Window & {
  __pwNativeHost?: unknown
  __pwNativeIntent?: (request: unknown) => Promise<unknown>
  webkit?: unknown
}
const A: SceneFlowNode = {
  id: 'a',
  type: 'scene',
  position: { x: 0, y: 0 },
  data: {
    name: 'A',
    sceneNo: 1,
    interior: false,
    time: '',
    synopsis: '',
    characterIds: [],
  },
}
const B: SceneFlowNode = {
  ...A,
  id: 'b',
  position: { x: 100, y: 0 },
  data: { ...A.data, name: 'B', sceneNo: 2 },
}
const PROJECT: EditorProjectContent = {
  id: 'projection-project',
  name: 'Committed',
  nodes: [A, B],
  edges: [],
  settings: { characters: [], locations: [] },
}
const save = () => undefined

/** Production provider and boundary permit genuinely abandoned shell renders. */
function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ReactFlowProvider>
      <Suspense fallback={null}>{children}</Suspense>
    </ReactFlowProvider>
  )
}

/** Capture the actual JSON wire shape without replacing controller or transport policy. */
function fixture(
  swift = true,
  project = PROJECT,
  useShell = useNativeEditorShell,
) {
  const post = vi.fn()
  const renders = vi.fn()
  if (swift)
    host.__pwNativeHost = {
      kind: 'swift',
      protocolVersion: 1,
      sessionId: 'projection-page',
    }
  host.webkit = { messageHandlers: { canvasHost: { postMessage: post } } }
  const builds = vi.spyOn(outline, 'buildOutlineGroups')
  const strings = vi.spyOn(JSON, 'stringify')
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const attempts = vi.fn()
  const hook = renderHook(
    ({ name, draft }: { name: string; draft: boolean }) => {
      renders()
      const viewport = useReactFlow()
      const editor = useEditorController({
        project,
        onSave: save,
        screenToFlowPosition: viewport.screenToFlowPosition,
        fitView: viewport.fitView,
      })
      useShell({
        projectId: PROJECT.id,
        project: { ...project, name },
        aiSessionLoadFailed: false,
        aiSessionError: null,
        editor,
        viewport,
      })
      if (draft) {
        attempts()
        throw pending
      }
      return { editor }
    },
    { wrapper: Wrapper, initialProps: { name: PROJECT.name, draft: false } },
  )
  const projection = () =>
    post.mock.calls[post.mock.calls.length - 1]![0].projection.editor
  const encodedCount = () =>
    strings.mock.calls.filter(
      ([value]) =>
        value &&
        typeof value === 'object' &&
        'contentRevision' in value &&
        'projectId' in value,
    ).length
  return {
    ...hook,
    builds,
    renders,
    encodedCount,
    projection,
    post,
    attempts,
    release,
  }
}

/** Real position changes leave content stable; x ties follow the shared id comparator. */
function move(view: ReturnType<typeof fixture>, x: number, y = 0) {
  act(() =>
    view.result.current.editor.doc.onNodesChange([
      { type: 'position', id: 'a', position: { x, y }, dragging: true },
    ]),
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete host.__pwNativeHost
  delete host.webkit
})

it('reuses outline and encoded projection on same-order position/session frames', () => {
  const view = fixture()
  const builds = view.builds.mock.calls.length
  const strings = view.encodedCount()
  const posts = view.post.mock.calls.length
  for (const x of [1, 40, 100]) move(view, x, 55)
  act(() =>
    view.result.current.editor.doc.onNodesChange([
      { type: 'dimensions', id: 'a', dimensions: { width: 240, height: 120 } },
    ]),
  )
  expect(view.result.current.editor.doc.nodes[0]?.position).toEqual({
    x: 100,
    y: 55,
  })
  expect(
    view.projection().outline[0].rows.map((row: { id: string }) => row.id),
  ).toEqual(['a', 'b'])
  expect(view.builds.mock.calls).toHaveLength(builds)
  expect(view.encodedCount()).toBe(strings)
  expect(view.post.mock.calls).toHaveLength(posts)
})

it('publishes true x/id ordering changes and preserves current position on later content/edge changes', () => {
  const view = fixture()
  move(view, 101)
  expect(
    view.projection().outline[0].rows.map((row: { id: string }) => row.id),
  ).toEqual(['b', 'a'])
  move(view, 100)
  expect(
    view.projection().outline[0].rows.map((row: { id: string }) => row.id),
  ).toEqual(['a', 'b'])
  act(() =>
    view.result.current.editor.doc.setNodes((nodes) =>
      nodes.map((node) =>
        node.id === 'a' && node.type === 'scene'
          ? { ...node, data: { ...A.data, name: 'Changed' } }
          : node,
      ),
    ),
  )
  expect(view.projection().nodes[0].label).toContain('Changed')
  act(() =>
    view.result.current.editor.doc.setEdges([
      { id: 'ba', source: 'b', target: 'a' },
    ]),
  )
  expect(view.projection().outline).toEqual(
    outline.buildOutlineGroups(
      view.result.current.editor.doc.nodes,
      view.result.current.editor.doc.edges,
      {},
    ),
  )
  expect(view.result.current.editor.doc.nodes[0]?.position.x).toBe(100)
})

it('keeps every non-position projection field live without rebuilding the outline', () => {
  const view = fixture()
  const builds = view.builds.mock.calls.length
  act(() => view.result.current.editor.panels.toggleSettings('b'))
  expect(view.projection()).toMatchObject({
    selected: { id: 'b', data: B.data },
    editingNodeId: 'b',
    inspectorSeeds: [],
  })
  act(() => view.result.current.editor.panels.toggleRight('ai'))
  expect(view.projection().aiOpen).toBe(true)
  act(() =>
    view.result.current.editor.doc.updateViewport({ x: 3, y: 4, zoom: 2 }),
  )
  expect(view.projection().zoom).toBe(2)
  act(() => view.result.current.editor.doc.setFocusedEpisode(7))
  expect(view.projection().focusedEpisode).toBe(7)
  act(() =>
    view.result.current.editor.doc.setSettings({
      characters: [{ id: 'c', name: 'Character', bio: '', gradient: 'blue' }],
      locations: [],
    }),
  )
  expect(view.projection().settings.characters[0].name).toBe('Character')
  act(() =>
    view.result.current.editor.doc.setAssets({
      byId: {
        'image-a': {
          id: 'image-a',
          relPath: 'assets/image-a.png',
          mime: 'image/png',
          source: 'upload',
          createdAt: '2026-10-21T00:00:00Z',
        },
      },
    }),
  )
  expect(view.projection().assets.byId['image-a'].mime).toBe('image/png')
  expect(view.builds.mock.calls).toHaveLength(builds)
  act(() => view.result.current.editor.doc.setEpisodeTitles({ 7: 'Episode' }))
  expect(view.builds.mock.calls.length).toBeGreaterThan(builds)
})

it('does not derive or encode native chrome on a non-Swift host', () => {
  const view = fixture(false)
  move(view, 10)
  expect(view.builds).not.toHaveBeenCalled()
  expect(view.encodedCount()).toBe(0)
  expect(view.post).not.toHaveBeenCalled()
})

/** Intent ownership must remain at the same commit boundary as the rendered native chrome. */
it('does not admit an abandoned project name through native export or revision', async () => {
  const view = fixture()
  const revision = view.projection().contentRevision
  const posts = view.post.mock.calls.length
  try {
    await act(async () => {
      startTransition(() => view.rerender({ name: 'Abandoned', draft: true }))
    })
    expect(view.attempts).toHaveBeenCalled()
    expect(view.post.mock.calls).toHaveLength(posts)
    const result = await host.__pwNativeIntent?.({
      protocolVersion: 1,
      sessionId: 'projection-page',
      requestId: 'export-committed',
      command: 'editor.exportPreview',
      args: { projectId: PROJECT.id, format: 'json' },
    })
    expect(result).toMatchObject({ ok: { fileName: 'Committed-剧本.json' } })
    act(() => view.rerender({ name: PROJECT.name, draft: false }))
    expect(view.projection().contentRevision).toBe(revision)
    expect(view.post.mock.calls).toHaveLength(posts)
  } finally {
    view.unmount()
    view.release()
  }
})

it('reuses the selected inspector payload and preparation seeds during same-order movement', () => {
  const view = fixture()
  act(() => view.result.current.editor.panels.toggleSettings('a'))
  const before = view.projection()
  const strings = view.encodedCount()
  const builds = view.builds.mock.calls.length
  move(view, 50, 80)
  expect(view.projection()).toEqual(before)
  expect(view.result.current.editor.doc.nodes[0]?.position).toEqual({
    x: 50,
    y: 80,
  })
  expect(view.encodedCount()).toBe(strings)
  expect(view.builds.mock.calls).toHaveLength(builds)
})

it('invalidates the shared order cache for attached shots and retains host episode/title changes', () => {
  const shot = (
    id: string,
    x: number,
  ): import('../nodes/types').CanvasNode => ({
    id,
    type: 'shot',
    position: { x, y: 0 },
    data: {
      shotNo: 1,
      size: '远景',
      picture: '',
      prompt: '',
      refs: [],
    },
  })
  const view = fixture(true, {
    ...PROJECT,
    nodes: [
      { ...A, data: { ...A.data, episodeNo: 2 } },
      shot('shot-a', 10),
      shot('shot-b', 20),
    ],
    edges: ['shot-a', 'shot-b'].map((target) => ({
      id: target,
      source: 'a',
      target,
      sourceHandle: 'shots',
    })),
  })
  act(() =>
    view.result.current.editor.doc.onNodesChange([
      { type: 'position', id: 'shot-a', position: { x: 30, y: 0 } },
    ]),
  )
  const doc = view.result.current.editor.doc
  expect(view.projection().outline).toEqual(
    outline.buildOutlineGroups(doc.nodes, doc.edges, doc.episodeTitles),
  )
  act(() => view.result.current.editor.doc.setEpisodeTitles({ 2: 'Second' }))
  expect(view.projection().outline[0].title).toBe('Second')
})

/** Same real controller without native delivery establishes its own required render work. */
function useNoNativeShell() {
  return undefined
}

/** Apply identical document mutations to the bare and native-enabled controller owners. */
function changeNonNativeField(view: ReturnType<typeof fixture>, field: string) {
  act(() => {
    const doc = view.result.current.editor.doc
    switch (field) {
      case 'edges':
        doc.setEdges([{ id: 'ab', source: 'a', target: 'b' }])
        break
      case 'settings':
        doc.setSettings({ characters: [], locations: [] })
        break
      case 'assets':
        doc.setAssets({ byId: {} })
        break
      case 'viewport':
        doc.updateViewport({ x: 8, y: 10, zoom: 2 })
        break
      case 'name':
        view.rerender({ name: 'Renamed', draft: false })
        break
    }
  })
}

it.each(['edges', 'settings', 'assets', 'viewport', 'name'])(
  'non-Swift %s updates do not create a native-only render pass',
  (field) => {
    const control = fixture(false, PROJECT, useNoNativeShell)
    control.renders.mockClear()
    changeNonNativeField(control, field)
    const requiredRenders = control.renders.mock.calls.length
    expect(requiredRenders).toBeGreaterThan(0)
    control.unmount()
    vi.restoreAllMocks()
    const view = fixture(false)
    view.renders.mockClear()
    changeNonNativeField(view, field)
    expect(view.renders).toHaveBeenCalledTimes(requiredRenders)
    expect(view.builds).not.toHaveBeenCalled()
    expect(view.encodedCount()).toBe(0)
    expect(view.post).not.toHaveBeenCalled()
  },
)
