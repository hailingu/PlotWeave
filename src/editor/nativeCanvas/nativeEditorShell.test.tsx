// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { branchOptionHandle } from '../graphRules'
import { libraryStore } from '../../library/libraryStore'
import { settingsStore } from '../../settings/settingsStore'
import { projectAssets } from '../projectAssets'
import { EditorView } from '../EditorView'
import type { EditorProjectContent } from '../useEditorDocument'
import type { ProjectContent } from '../../model/content'
import type { SceneFlowNode } from '../nodes/types'

/** The real production controller receives intents through its injected native marker. */
const host = window as Window & {
  __pwNativeHost?: unknown
  __pwNativeIntent?: (request: unknown) => Promise<unknown>
  webkit?: unknown
}
/** Concrete scene fixture preserves its discriminator when deriving test variations. */
const SCENE: SceneFlowNode = {
  id: 'scene-a',
  type: 'scene',
  position: { x: 0, y: 0 },
  data: {
    name: '天台',
    sceneNo: 1,
    interior: false,
    time: '夜',
    synopsis: '开场',
    characterIds: [],
  },
}
/** Production editor content uses the typed scene without widening derived node data. */
const PROJECT: EditorProjectContent = {
  id: 'native-project',
  name: '原生往返',
  edges: [],
  settings: { characters: [], locations: [] },
  nodes: [SCENE],
}
let requestNo = 0

it('native outlineMove 拒绝分支 after 并保持保存载荷（#903）', async () => {
  const project: EditorProjectContent = {
    ...PROJECT,
    nodes: [
      ...['p', 'x', 'n', 'a'].map((id) => ({ ...SCENE, id })),
      {
        id: 'br',
        type: 'branch',
        position: { x: 500, y: 0 },
        data: { prompt: '选择？', options: [] },
      },
    ],
    edges: [
      ['p', 'x'],
      ['x', 'n'],
      ['a', 'br'],
    ].map(([source, target], i) => ({
      id: `e${i}`,
      source,
      target,
      className: 'pw-edge-sequence',
    })),
  }
  const view = nativeEditorFixture(project)
  const before = await exportedDocument()
  await act(async () => {
    await intent('editor.outlineMove', {
      id: 'x',
      target: { kind: 'row', anchorId: 'br', position: 'after' },
    })
  })
  expect((await exportedDocument()).graph).toEqual(before.graph)
  expect(view.getByRole('alert').textContent).toContain('大纲拖拽未执行')
  await act(async () => {
    await intent('editor.undo')
  })
  expect((await exportedDocument()).graph).toEqual(before.graph)
})

it('native outlineMove 同组全游离组尾静默无操作（#904）', async () => {
  const view = nativeEditorFixture({
    ...PROJECT,
    nodes: [{ ...SCENE, data: { ...SCENE.data, episodeNo: 2 } }],
  })
  const before = await exportedDocument()
  await act(async () => {
    await intent('editor.outlineMove', {
      id: SCENE.id,
      target: { kind: 'groupEnd', episode: 2 },
    })
  })
  expect((await exportedDocument()).graph).toEqual(before.graph)
  expect(view.queryByRole('alert')).toBeNull()
})

/** Explicit project targeting prevents old native panels from editing a newer project. */
function intent(command: string, args: Record<string, unknown> = {}) {
  return host.__pwNativeIntent?.({
    protocolVersion: 1,
    sessionId: 'editor-page',
    requestId: String(++requestNo),
    command,
    args: { projectId: PROJECT.id, ...args },
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete host.__pwNativeHost
  delete host.webkit
})

it('native attribute edit, undo and redo persist through the production controller', async () => {
  host.__pwNativeHost = {
    kind: 'swift',
    protocolVersion: 1,
    sessionId: 'editor-page',
  }
  host.webkit = {
    messageHandlers: {
      canvasHost: { postMessage: vi.fn() },
      plotweaveHost: { postMessage: async () => ({ ok: {} }) },
    },
  }
  const saved: ProjectContent[] = []
  const view = render(
    <EditorView
      project={PROJECT}
      onBackHome={() => undefined}
      onRenameProject={() => undefined}
      onSave={(doc) => {
        saved.push(doc)
      }}
    />,
  )
  expect(view.queryByRole('button', { name: '返回首页' })).toBeNull()
  expect(view.queryByRole('region', { name: '故事大纲' })).toBeNull()
  await act(async () => {
    await intent('editor.nodeSettings', { id: 'scene-a' })
  })
  expect(view.queryByLabelText('节点设置')).toBeNull()
  await waitFor(() => expect(host.__pwNativeIntent).toBeTypeOf('function'))
  await act(async () => {
    await intent('editor.patchNode', {
      id: 'scene-a',
      patch: { synopsis: '改稿' },
    })
  })
  await waitFor(() =>
    expect(saved[saved.length - 1]?.nodes[0]?.data.synopsis).toBe('改稿'),
  )
  await act(async () => {
    await intent('editor.undo')
  })
  await waitFor(() =>
    expect(saved[saved.length - 1]?.nodes[0]?.data.synopsis).toBe('开场'),
  )
  await act(async () => {
    await intent('editor.redo')
  })
  await waitFor(() =>
    expect(saved[saved.length - 1]?.nodes[0]?.data.synopsis).toBe('改稿'),
  )
  let rejected: unknown
  await act(async () => {
    rejected = await intent('editor.patchNode', {
      id: 'gone',
      patch: { synopsis: '不应创建' },
    })
  })
  expect(rejected).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  expect(saved[saved.length - 1]?.nodes).toHaveLength(1)
})

it('native entity actions share history and export preserves the current unsaved document', async () => {
  host.__pwNativeHost = {
    kind: 'swift',
    protocolVersion: 1,
    sessionId: 'editor-page',
  }
  host.webkit = {
    messageHandlers: {
      canvasHost: { postMessage: vi.fn() },
      plotweaveHost: { postMessage: async () => ({ ok: {} }) },
    },
  }
  const saved: ProjectContent[] = []
  render(
    <EditorView
      project={PROJECT}
      onBackHome={() => undefined}
      onRenameProject={() => undefined}
      onSave={(doc) => {
        saved.push(doc)
      }}
    />,
  )
  let created: unknown
  await act(async () => {
    created = await intent('editor.entityCreate', { kind: 'character' })
  })
  expect(created).toEqual({ ok: null })
  await waitFor(() =>
    expect(saved[saved.length - 1]?.settings.characters).toHaveLength(1),
  )
  const id = saved[saved.length - 1]?.settings.characters[0]?.id
  await act(async () => {
    await intent('editor.entityUpdate', {
      kind: 'character',
      id,
      patch: { name: '林舟', bio: '女主角' },
    })
  })
  let exported: unknown
  await act(async () => {
    exported = await intent('editor.exportPreview', { format: 'json' })
  })
  expect(exported).toMatchObject({
    ok: { format: 'json', fileName: '原生往返-剧本.json' },
  })
  const document = JSON.parse((exported as { ok: { text: string } }).ok.text)
  expect(document.settings.characters[id as string]).toMatchObject({
    id,
    name: '林舟',
    bio: '女主角',
  })
  await act(async () => {
    await intent('editor.undo')
  })
  await waitFor(() =>
    expect(saved[saved.length - 1]?.settings.characters[0]?.name).toBe(
      '新角色',
    ),
  )
  await act(async () => {
    await intent('editor.entityDelete', { kind: 'character', id })
  })
  let rejected: unknown
  await act(async () => {
    rejected = await intent('editor.entityUpdate', {
      kind: 'character',
      id,
      patch: { bio: '不能复活' },
    })
  })
  expect(rejected).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
})

it('native export preview outline argument selects the appendix: default-off sheets export plain Markdown, JSON ignores it', async () => {
  nativeEditorFixture()
  let plain: unknown
  await act(async () => {
    plain = await intent('editor.exportPreview', {
      format: 'md',
      outline: false,
    })
  })
  const plainText = (plain as { ok: { text: string; fileName: string } }).ok
    .text
  expect((plain as { ok: { fileName: string } }).ok.fileName).toBe(
    '原生往返-剧本.md',
  )
  expect(plainText).toContain('天台')
  expect(plainText).not.toContain('附录 · 创作大纲')
  let withOutline: unknown
  await act(async () => {
    withOutline = await intent('editor.exportPreview', {
      format: 'md',
      outline: true,
    })
  })
  expect((withOutline as { ok: { text: string } }).ok.text).toContain(
    '附录 · 创作大纲',
  )
  let jsonWithoutOutline: unknown
  let jsonWithOutline: unknown
  await act(async () => {
    jsonWithoutOutline = await intent('editor.exportPreview', {
      format: 'json',
      outline: false,
    })
    jsonWithOutline = await intent('editor.exportPreview', {
      format: 'json',
      outline: true,
    })
  })
  const jsonText = (jsonWithoutOutline as { ok: { text: string } }).ok.text
  expect(JSON.parse(jsonText).graph).toBeDefined()
  expect((jsonWithOutline as { ok: { text: string } }).ok.text).toBe(jsonText)
})

/** Creates only the explicit host transport; production document and history remain real. */
function nativeEditorFixture(project = PROJECT) {
  const projections: unknown[] = []
  host.__pwNativeHost = {
    kind: 'swift',
    protocolVersion: 1,
    sessionId: 'editor-page',
  }
  host.webkit = {
    messageHandlers: {
      canvasHost: { postMessage: (value: unknown) => projections.push(value) },
      plotweaveHost: { postMessage: async () => ({ ok: {} }) },
    },
  }
  const view = render(
    <EditorView
      project={project}
      onBackHome={() => undefined}
      onRenameProject={() => undefined}
      onSave={() => undefined}
    />,
  )
  return { ...view, editorProjection: () => readEditorProjection(projections) }
}

/** Native presentation observations stay separate from the authoritative document export. */
interface NodeSettingsProjection {
  inspectorSeeds: { id: string; type: string; data: Record<string, unknown> }[]
  aiOpen: boolean
  editingNodeId: string | null
  nodeSettingsRequest: number
  selected: { id: string } | null
  contentRevision: number
  canUndo: boolean
}

/** Reads the latest aggregate transport snapshot emitted by the real controller. */
function readEditorProjection(projections: unknown[]): NodeSettingsProjection {
  const envelope = projections[projections.length - 1] as {
    projection: { editor: NodeSettingsProjection }
  }
  return envelope.projection.editor
}

/** Reads the authoritative serializer rather than any mirrored native projection. */
async function exportedDocument() {
  const result = (await intent('editor.exportPreview', { format: 'json' })) as {
    ok: { text: string }
  }
  return JSON.parse(result.ok.text)
}

it('projects one inspector preparation seed without selecting or editing the document', async () => {
  const view = nativeEditorFixture(PROJECT)
  expect(view.editorProjection()).toMatchObject({
    inspectorSeeds: [{ id: SCENE.id, type: SCENE.type, data: SCENE.data }],
    selected: null,
    editingNodeId: null,
    canUndo: false,
  })
  const document = await exportedDocument()
  expect(document.graph.nodes).toHaveLength(1)
  expect(document.graph.nodes[0].id).toBe(SCENE.id)
  const { name, ...spec } = SCENE.data
  expect(document.graph.nodes[0].data.meta.label).toBe(name)
  expect(document.graph.nodes[0].data.spec).toEqual(spec)
})

it('empty and selected projects do not duplicate a preparation seed', async () => {
  const view = nativeEditorFixture({ ...PROJECT, nodes: [] })
  expect(view.editorProjection().inspectorSeeds).toEqual([])
  await act(async () => {
    await intent('editor.create', { nodeType: 'scene' })
  })
  const firstSelected = view.editorProjection().selected?.id
  expect(firstSelected).toBeTruthy()
  expect(view.editorProjection().inspectorSeeds).toEqual([])
  await act(async () => {
    await intent('editor.create', { nodeType: 'beat' })
  })
  expect(view.editorProjection().inspectorSeeds).toMatchObject([
    { id: firstSelected, type: 'scene' },
  ])
  expect(view.editorProjection().selected?.id).not.toBe(firstSelected)
})

it('prepares one representative per existing kind instead of one form per graph node', () => {
  const project = nativeListProject()
  const view = nativeEditorFixture({
    ...project,
    nodes: [...project.nodes, { ...SCENE, id: 'other-scene' }],
  })
  const seeds = view.editorProjection().inspectorSeeds
  expect(seeds).toHaveLength(
    new Set(project.nodes.map((node) => node.type)).size,
  )
  expect(new Set(seeds.map((node) => node.type)).size).toBe(seeds.length)
  expect(seeds.length).toBeLessThanOrEqual(6)
  expect(seeds.filter((node) => node.type === 'scene')).toMatchObject([
    { id: SCENE.id },
  ])
})

it('consecutive native entity edits retain both fields before acknowledgment', async () => {
  nativeEditorFixture({
    ...PROJECT,
    settings: {
      characters: [{ id: 'c', name: '原名', gradient: 'blue' }],
      locations: [],
    },
  })
  await act(async () => {
    await intent('editor.entityUpdate', {
      kind: 'character',
      id: 'c',
      patch: { name: '林舟' },
    })
    await intent('editor.entityUpdate', {
      kind: 'character',
      id: 'c',
      patch: { bio: '保留名称' },
    })
  })
  expect((await exportedDocument()).settings.characters.c).toMatchObject({
    name: '林舟',
    bio: '保留名称',
  })
})

/** Builds a real dialogue and connected branch fixture without obscuring the transition assertions. */
function nativeListProject(): EditorProjectContent {
  return {
    ...PROJECT,
    settings: {
      characters: [{ id: 'c', name: '角色', gradient: 'blue' }],
      locations: [],
    },
    nodes: [
      ...PROJECT.nodes,
      {
        id: 'dialogue',
        type: 'dialogue',
        position: { x: 1, y: 1 },
        data: {
          name: '对白',
          lines: [
            {
              id: 'line',
              kind: 'line',
              text: '原文',
              speaker: 'c',
              side: 'left',
            },
          ],
        },
      },
      {
        id: 'branch',
        type: 'branch',
        position: { x: 2, y: 2 },
        data: { prompt: '选择', options: [{ id: 'choice', label: '继续' }] },
      },
    ],
    edges: [
      {
        id: 'choice-edge',
        source: 'branch',
        sourceHandle: branchOptionHandle('choice'),
        target: 'scene-a',
        data: { kind: 'branch' },
      },
    ],
  }
}

it('native list items merge current state and branch removal shares edge undo', async () => {
  nativeEditorFixture(nativeListProject())
  let changed: unknown
  await act(async () => {
    changed = await intent('editor.patchListItem', {
      id: 'dialogue',
      field: 'lines',
      itemId: 'line',
      patch: { text: '新文' },
    })
    await intent('editor.patchListItem', {
      id: 'dialogue',
      field: 'lines',
      itemId: 'line',
      patch: { kind: 'action' },
    })
  })
  expect(changed).toEqual({ ok: null })
  const dialogue = (await exportedDocument()).graph.nodes.find(
    (node: { id: string }) => node.id === 'dialogue',
  ).data.spec.lines[0]
  expect(dialogue).toMatchObject({ text: '新文', kind: 'action' })
  expect(dialogue.speaker).toBeUndefined()
  await act(async () => {
    await intent('editor.deleteListItem', {
      id: 'branch',
      field: 'options',
      itemId: 'choice',
    })
  })
  expect((await exportedDocument()).graph.edges).toHaveLength(0)
  await act(async () => {
    await intent('editor.undo')
  })
  expect((await exportedDocument()).graph.edges).toHaveLength(1)
  let stale: unknown
  await act(async () => {
    stale = await intent('editor.patchListItem', {
      id: 'dialogue',
      field: 'lines',
      itemId: 'gone',
      patch: { text: '不能复活' },
    })
  })
  expect(stale).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
})

it('native image input edits use the image contract without AI-write privileges', async () => {
  nativeEditorFixture({
    ...PROJECT,
    nodes: [
      {
        id: 'image',
        type: 'image',
        position: { x: 0, y: 0 },
        data: { prompt: '旧画面', model: '', size: '1024x1536', outputs: {} },
      },
    ],
  })
  let result: unknown
  await act(async () => {
    result = await intent('editor.patchNode', {
      id: 'image',
      patch: { prompt: '新画面', size: '1024x1024' },
    })
  })
  expect(result).toEqual({ ok: null })
  expect((await exportedDocument()).graph.nodes[0].data.spec).toMatchObject({
    prompt: '新画面',
    size: '1024x1024',
  })
  await act(async () => {
    result = await intent('editor.patchNode', {
      id: 'image',
      patch: { outputs: { primary: { assetId: 'forged' } } },
    })
  })
  expect(result).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
})

/** The native command still receives authoritative library MIME through its production facade. */
function libraryAssetFixture() {
  vi.spyOn(libraryStore, 'list').mockResolvedValue([
    {
      id: 'library',
      name: '角色图',
      kind: 'character',
      mime: 'image/png',
      relPath: 'media/library.png',
      view: null,
      groupId: null,
      tags: [],
      createdAt: '2026-10-04T00:00:00Z',
    },
  ])
  return {
    id: 'asset',
    relPath: 'assets/asset.png',
    mime: 'image/png',
    source: 'upload' as const,
    createdAt: '2026-10-04T00:00:00Z',
  }
}

it('native library binding and undo keep project index and shot references together', async () => {
  const asset = libraryAssetFixture()
  vi.spyOn(projectAssets, 'importFromLibrary').mockResolvedValue(asset)
  nativeEditorFixture({
    ...PROJECT,
    nodes: [
      {
        id: 'shot',
        type: 'shot',
        position: { x: 0, y: 0 },
        data: { shotNo: 1, size: '近景', picture: '', prompt: '', refs: [] },
      },
    ],
  })
  let result: unknown
  await act(async () => {
    result = await intent('editor.importLibraryAsset', {
      assetId: 'library',
      targetNodeId: 'shot',
    })
  })
  expect(result).toEqual({ ok: null })
  let document = await exportedDocument()
  expect(document.assets.byId.asset).toEqual(asset)
  expect(document.graph.nodes[0].data.spec.refs).toMatchObject([
    { assetId: 'asset', kind: 'character' },
  ])
  await act(async () => {
    await intent('editor.undo')
  })
  document = await exportedDocument()
  expect(document.assets.byId.asset).toBeUndefined()
  expect(document.graph.nodes[0].data.spec.refs).toEqual([])
})

it('late native library completion cannot bind a deleted target', async () => {
  const asset = libraryAssetFixture()
  const discard = vi.spyOn(projectAssets, 'discardImport').mockResolvedValue()
  let complete!: (value: typeof asset) => void
  vi.spyOn(projectAssets, 'importFromLibrary').mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  nativeEditorFixture({
    ...PROJECT,
    nodes: [
      {
        id: 'shot',
        type: 'shot',
        position: { x: 0, y: 0 },
        data: { shotNo: 1, size: '近景', picture: '', prompt: '', refs: [] },
      },
    ],
  })
  let pending: Promise<unknown> | undefined
  await act(async () => {
    pending = intent('editor.importLibraryAsset', {
      assetId: 'library',
      targetNodeId: 'shot',
    })
    await Promise.resolve()
  })
  await act(async () => {
    await intent('editor.delete', { id: 'shot' })
    complete(asset)
    await pending
  })
  const document = await exportedDocument()
  expect(document.assets.byId.asset).toBeUndefined()
  expect(document.graph.nodes).toEqual([])
  expect(discard).toHaveBeenCalledWith(
    'native-project',
    asset.id,
    expect.any(Error),
  )
})

it('native optional fields clear through the existing serialization contract', async () => {
  nativeEditorFixture({
    ...PROJECT,
    nodes: [
      {
        ...SCENE,
        data: {
          ...SCENE.data,
          episodeNo: 2,
          locationId: 'location',
        },
      },
    ],
    settings: { characters: [], locations: [{ id: 'location', name: '天台' }] },
  })
  await act(async () => {
    await intent('editor.clearNodeField', { id: 'scene-a', field: 'episodeNo' })
    await intent('editor.clearNodeField', {
      id: 'scene-a',
      field: 'locationId',
    })
  })
  const node = (await exportedDocument()).graph.nodes[0]
  expect(node.data.meta.episodeNo).toBeUndefined()
  expect(node.data.spec.locationId).toBeUndefined()
})

it('native image job uses production generation, output-index history and undo', async () => {
  vi.spyOn(settingsStore, 'load').mockResolvedValue({
    providers: [
      {
        id: 'test',
        label: '测试',
        baseUrl: 'https://example.test/v1',
        enabled: true,
        models: ['image'],
        keyEnc: 'fixture',
      },
    ],
    defaultChat: null,
    defaultImage: 'test:image',
  })
  nativeEditorFixture({
    ...PROJECT,
    nodes: [
      {
        id: 'image',
        type: 'image',
        position: { x: 0, y: 0 },
        data: { prompt: '角色定妆', model: '', size: '1024x1536', outputs: {} },
      },
    ],
  })
  const asset = {
    id: 'generated',
    relPath: 'assets/generated.png',
    mime: 'image/png',
    source: 'generated',
    createdAt: '2026-10-04T00:00:00Z',
  }
  host.webkit = {
    messageHandlers: {
      canvasHost: { postMessage: vi.fn() },
      plotweaveHost: {
        postMessage: async (request: { command: string }) => ({
          ok:
            request.command === 'llm_image_generate' ||
            request.command === 'validate_project_asset'
              ? asset
              : null,
        }),
      },
    },
  }
  let result: unknown
  await act(async () => {
    result = await intent('image.start', { id: 'image' })
  })
  expect(result).toEqual({ ok: null })
  await waitFor(async () =>
    expect(
      (await exportedDocument()).graph.nodes[0].data.spec.outputs.primary
        ?.assetId,
    ).toBe('generated'),
  )
  expect((await exportedDocument()).assets.byId.generated).toEqual(asset)
  await act(async () => {
    await intent('editor.undo')
  })
  const document = await exportedDocument()
  expect(document.assets.byId.generated).toBeUndefined()
  expect(document.graph.nodes[0].data.spec.outputs.primary).toBeUndefined()
})

it('native document relations and outline reordering share ordinary document history', async () => {
  nativeEditorFixture({
    ...PROJECT,
    settings: {
      characters: [{ id: 'c', name: '角色', gradient: 'blue' }],
      locations: [],
      documents: [{ id: 'doc', title: '小传', body: '', relatedIds: [] }],
    },
    nodes: [
      ...PROJECT.nodes,
      {
        ...SCENE,
        id: 'scene-b',
        data: { ...SCENE.data, name: '场二', sceneNo: 2 },
      },
      {
        ...SCENE,
        id: 'scene-c',
        data: { ...SCENE.data, name: '场三', sceneNo: 3 },
      },
    ],
    edges: [
      {
        id: 'ab',
        source: 'scene-a',
        target: 'scene-b',
        className: 'pw-edge-sequence',
      },
      {
        id: 'bc',
        source: 'scene-b',
        target: 'scene-c',
        className: 'pw-edge-sequence',
      },
    ],
  })
  let result: unknown
  await act(async () => {
    result = await intent('editor.toggleDocumentRelation', {
      id: 'doc',
      kind: 'character',
      entityId: 'c',
    })
  })
  expect(result).toEqual({ ok: null })
  expect((await exportedDocument()).settings.documents.doc.relatedIds).toEqual([
    { kind: 'character', id: 'c' },
  ])
  await act(async () => {
    result = await intent('editor.outlineMove', {
      id: 'scene-b',
      target: { kind: 'row', anchorId: 'scene-c', position: 'after' },
    })
  })
  expect(result).toEqual({ ok: null })
  expect(
    (await exportedDocument()).graph.edges.map(
      (edge: { source: string; target: string }) => [edge.source, edge.target],
    ),
  ).toEqual([
    ['scene-a', 'scene-c'],
    ['scene-c', 'scene-b'],
  ])
  await act(async () => {
    await intent('editor.undo')
  })
  expect(
    (await exportedDocument()).graph.edges.map(
      (edge: { source: string; target: string }) => [edge.source, edge.target],
    ),
  ).toEqual([
    ['scene-a', 'scene-b'],
    ['scene-b', 'scene-c'],
  ])
})

it('native AI load failure remains visible and cannot start an empty replacement thread', async () => {
  const projections: unknown[] = []
  host.__pwNativeHost = {
    kind: 'swift',
    protocolVersion: 1,
    sessionId: 'editor-page',
  }
  host.webkit = {
    messageHandlers: {
      canvasHost: {
        postMessage: (value: unknown) => {
          projections.push(value)
        },
      },
      plotweaveHost: { postMessage: async () => ({ ok: {} }) },
    },
  }
  render(
    <EditorView
      project={PROJECT}
      onBackHome={() => undefined}
      onRenameProject={() => undefined}
      onSave={() => undefined}
      aiSessionLoadFailed
      aiSessionError="会话磁盘不可读"
    />,
  )
  await waitFor(() =>
    expect(
      projections.some(
        (value) =>
          (
            value as {
              projection?: {
                editor?: {
                  aiSessionLoadFailed?: boolean
                  aiSessionError?: string
                }
              }
            }
          ).projection?.editor?.aiSessionLoadFailed === true,
      ),
    ).toBe(true),
  )
  expect(await intent('ai.send', { text: '不能覆盖' })).toMatchObject({
    error: { code: 'PW_INTENT_UNAVAILABLE' },
  })
})

it('native delete preview requires confirmation and executes once through real graph undo', async () => {
  nativeEditorFixture()
  cleanup()
  render(
    <EditorView
      project={PROJECT}
      onBackHome={() => undefined}
      onRenameProject={() => undefined}
      onSave={() => undefined}
      aiSession={{
        schemaVersion: 1,
        entries: [
          {
            id: 1,
            kind: 'msg',
            role: 'assistant',
            text: '删除场景',
            card: {
              status: 'pending',
              v: {
                ok: true,
                hasDeletes: true,
                issues: [],
                items: [
                  {
                    kind: 'delete',
                    danger: true,
                    label: '删除场景',
                    key: 'delete',
                  },
                ],
                commands: [{ op: 'delete_node', nodeId: 'scene-a' }],
              },
            },
          },
        ],
      }}
    />,
  )
  let result: unknown
  await act(async () => {
    result = await intent('ai.execute', { entryId: 1 })
  })
  expect(result).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  expect((await exportedDocument()).graph.nodes).toHaveLength(1)
  await act(async () => {
    await intent('ai.arm', { entryId: 1 })
    result = await intent('ai.execute', { entryId: 1 })
  })
  expect(result).toEqual({ ok: null })
  expect((await exportedDocument()).graph.nodes).toEqual([])
  await act(async () => {
    await intent('editor.undo')
  })
  expect((await exportedDocument()).graph.nodes).toHaveLength(1)
  await act(async () => {
    result = await intent('ai.execute', { entryId: 1 })
  })
  expect(result).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
})

/** React commits each actual native reply before the test inspects its production document. */
async function nativeCommand(
  command: string,
  args: Record<string, unknown> = {},
) {
  let reply: unknown
  await act(async () => {
    reply = await intent(command, args)
  })
  return reply
}

/** Deleted references are retained by dev's document contract and must not lock ordinary native forms. */
function nativeDanglingProject(): EditorProjectContent {
  const staleLine = {
    id: 'stale-line',
    kind: 'line' as const,
    text: '旧台词',
    speaker: 'deleted',
    futureNote: '透传字段',
  }
  const staleRef = {
    id: 'stale-ref',
    kind: 'character' as const,
    assetId: 'missing-asset',
    futureNote: '保留引用',
  }
  return {
    ...PROJECT,
    settings: {
      characters: [{ id: 'hero', name: '角色', gradient: 'blue' }],
      locations: [],
      documents: [
        {
          id: 'doc',
          title: '设定',
          body: '',
          relatedIds: [{ kind: 'character', id: 'deleted' }],
        },
      ],
    },
    nodes: [
      { ...SCENE, data: { ...SCENE.data, characterIds: ['deleted'] } },
      {
        id: 'dialogue',
        type: 'dialogue',
        position: { x: 1, y: 1 },
        data: {
          name: '对白',
          lines: [
            staleLine,
            {
              id: 'healthy-line',
              kind: 'line',
              text: '正常台词',
              speaker: 'hero',
            },
          ],
        },
      },
      {
        id: 'shot',
        type: 'shot',
        position: { x: 2, y: 2 },
        data: {
          shotNo: 1,
          size: '',
          picture: '',
          prompt: '',
          refs: [
            staleRef,
            { id: 'healthy-ref', kind: 'character', label: '角色图' },
          ],
        },
      },
    ],
  }
}

it('native dialogue deltas preserve old missing references and extensions while validating new writes', async () => {
  nativeEditorFixture(nativeDanglingProject())
  const readLines = async () =>
    (await exportedDocument()).graph.nodes.find(
      (node: { id: string }) => node.id === 'dialogue',
    ).data.spec.lines
  const changed = await nativeCommand('editor.patchListItem', {
    id: 'dialogue',
    field: 'lines',
    itemId: 'healthy-line',
    patch: { text: '新台词' },
  })
  expect(changed).toEqual({ ok: null })
  expect(await readLines()).toMatchObject([
    { speaker: 'deleted', futureNote: '透传字段' },
    { text: '新台词' },
  ])
  await nativeCommand('editor.undo')
  expect((await readLines())[1].text).toBe('正常台词')
  await nativeCommand('editor.patchListItem', {
    id: 'dialogue',
    field: 'lines',
    itemId: 'stale-line',
    patch: { text: '保留旧引用' },
  })
  expect((await readLines())[0]).toMatchObject({
    speaker: 'deleted',
    text: '保留旧引用',
    futureNote: '透传字段',
  })
  for (const patch of [
    { speaker: 'missing-new' },
    { unknownField: '不能写' },
  ]) {
    const rejected = await nativeCommand('editor.patchListItem', {
      id: 'dialogue',
      field: 'lines',
      itemId: 'healthy-line',
      patch,
    })
    expect(rejected).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  }
  await nativeCommand('editor.insertListItem', {
    id: 'dialogue',
    field: 'lines',
  })
  expect(await readLines()).toHaveLength(3)
  await nativeCommand('editor.deleteListItem', {
    id: 'dialogue',
    field: 'lines',
    itemId: 'healthy-line',
  })
  expect((await readLines())[0].speaker).toBe('deleted')
  expect(await readLines()).toHaveLength(2)
})

it('native cast and document toggles preserve deleted relationships and reject new missing targets', async () => {
  nativeEditorFixture(nativeDanglingProject())
  const toggled = await nativeCommand('editor.toggleCharacter', {
    id: 'scene-a',
    characterId: 'hero',
  })
  expect(toggled).toEqual({ ok: null })
  expect(
    (await exportedDocument()).graph.nodes[0].data.spec.characterIds,
  ).toEqual(['deleted', 'hero'])
  await nativeCommand('editor.undo')
  expect(
    (await exportedDocument()).graph.nodes[0].data.spec.characterIds,
  ).toEqual(['deleted'])
  const related = await nativeCommand('editor.toggleDocumentRelation', {
    id: 'doc',
    kind: 'character',
    entityId: 'hero',
  })
  expect(related).toEqual({ ok: null })
  expect((await exportedDocument()).settings.documents.doc.relatedIds).toEqual([
    { kind: 'character', id: 'deleted' },
    { kind: 'character', id: 'hero' },
  ])
  await nativeCommand('editor.undo')
  expect((await exportedDocument()).settings.documents.doc.relatedIds).toEqual([
    { kind: 'character', id: 'deleted' },
  ])
  for (const [command, args] of [
    ['editor.toggleCharacter', { id: 'scene-a', characterId: 'missing-new' }],
    [
      'editor.toggleDocumentRelation',
      { id: 'doc', kind: 'character', entityId: 'missing-new' },
    ],
  ] as const) {
    const rejected = await nativeCommand(command, args)
    expect(rejected).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  }
})

it('native shot row deltas retain missing asset references without accepting new invalid bindings', async () => {
  nativeEditorFixture(nativeDanglingProject())
  const readRefs = async () =>
    (await exportedDocument()).graph.nodes.find(
      (node: { id: string }) => node.id === 'shot',
    ).data.spec.refs
  const changed = await nativeCommand('editor.patchListItem', {
    id: 'shot',
    field: 'refs',
    itemId: 'healthy-ref',
    patch: { label: '新自由位' },
  })
  expect(changed).toEqual({ ok: null })
  expect(await readRefs()).toMatchObject([
    { assetId: 'missing-asset', futureNote: '保留引用' },
    { label: '新自由位' },
  ])
  await nativeCommand('editor.undo')
  expect((await readRefs())[1].label).toBe('角色图')
  await nativeCommand('editor.patchListItem', {
    id: 'shot',
    field: 'refs',
    itemId: 'stale-ref',
    patch: { kind: 'character' },
  })
  expect((await readRefs())[0]).toMatchObject({
    assetId: 'missing-asset',
    futureNote: '保留引用',
  })
  for (const [itemId, patch] of [
    ['stale-ref', { assetId: 'another-missing' }],
    ['stale-ref', { kind: 'audio' }],
    ['healthy-ref', { unknownField: '不能写' }],
  ]) {
    const rejected = await nativeCommand('editor.patchListItem', {
      id: 'shot',
      field: 'refs',
      itemId,
      patch,
    })
    expect(rejected).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  }
  await nativeCommand('editor.insertListItem', { id: 'shot', field: 'refs' })
  expect(await readRefs()).toHaveLength(3)
  await nativeCommand('editor.deleteListItem', {
    id: 'shot',
    field: 'refs',
    itemId: 'healthy-ref',
  })
  expect((await readRefs())[0].assetId).toBe('missing-asset')
  expect(await readRefs()).toHaveLength(2)
})

it('a node click leaves AI and targets its own native form despite another selection', async () => {
  const view = nativeEditorFixture(nativeListProject())
  await act(async () => {
    await intent('editor.select', { id: 'scene-a' })
    await intent('editor.ai')
  })
  expect(view.editorProjection().aiOpen).toBe(true)
  const revision = view.editorProjection().contentRevision
  fireEvent.click(view.getByTestId('rf__node-dialogue'))
  expect(view.editorProjection()).toMatchObject({
    aiOpen: false,
    editingNodeId: 'dialogue',
    selected: { id: 'dialogue' },
    contentRevision: revision,
    canUndo: false,
  })
  await act(async () => {
    await intent('editor.patchNode', {
      id: view.editorProjection().selected?.id,
      patch: { name: '改过的对白' },
    })
  })
  const nodes = (await exportedDocument()).graph.nodes
  expect(
    nodes.find((node: { id: string }) => node.id === 'dialogue').data.meta
      .label,
  ).toBe('改过的对白')
  expect(
    nodes.find((node: { id: string }) => node.id === 'scene-a').data.meta.label,
  ).toBe('天台')
})

it('each native settings action presents the same target without changing document or history', async () => {
  const view = nativeEditorFixture(nativeListProject())
  const document = await exportedDocument()
  const revision = view.editorProjection().contentRevision
  fireEvent.click(view.getByTestId('rf__node-dialogue'))
  const request = view.editorProjection().nodeSettingsRequest
  expect(request).toBeGreaterThan(0)
  fireEvent.click(view.getByTestId('rf__node-dialogue'))
  expect(view.editorProjection()).toMatchObject({
    editingNodeId: 'dialogue',
    nodeSettingsRequest: request + 1,
  })
  await act(async () => {
    await intent('editor.nodeSettings', { id: 'dialogue' })
  })
  expect(view.editorProjection()).toMatchObject({
    editingNodeId: 'dialogue',
    nodeSettingsRequest: request + 2,
    contentRevision: revision,
    canUndo: false,
  })
  expect(await exportedDocument()).toEqual(document)
  await act(async () => {
    await intent('editor.ai')
  })
  expect(view.editorProjection().aiOpen).toBe(true)
})

it('settings requests reject stale projects and missing nodes without changing their target', async () => {
  const view = nativeEditorFixture(nativeListProject())
  fireEvent.click(view.getByTestId('rf__node-dialogue'))
  const projection = view.editorProjection()
  for (const args of [
    { id: 'gone' },
    { id: 'scene-a', projectId: 'old-project' },
  ]) {
    let rejected: unknown
    await act(async () => {
      rejected = await intent('editor.nodeSettings', args)
    })
    expect(rejected).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
    expect(view.editorProjection()).toEqual(projection)
  }
  fireEvent.click(view.getByTestId('rf__node-scene-a'))
  expect(view.editorProjection()).toMatchObject({
    editingNodeId: 'scene-a',
    selected: { id: 'scene-a' },
    nodeSettingsRequest: projection.nodeSettingsRequest + 1,
  })
})

it('native nodes omit redundant settings buttons and outline selection switches the current form', async () => {
  const view = nativeEditorFixture(nativeListProject())
  expect(view.queryByLabelText('对白设置')).toBeNull()
  expect(view.queryByLabelText('场景设置')).toBeNull()
  expect(view.queryByLabelText('分支设置')).toBeNull()
  fireEvent.click(view.getByTestId('rf__node-dialogue'))
  const request = view.editorProjection().nodeSettingsRequest
  await act(async () => {
    await intent('editor.ai')
    await intent('editor.select', { id: 'scene-a' })
  })
  expect(view.editorProjection()).toMatchObject({
    aiOpen: false,
    selected: { id: 'scene-a' },
    editingNodeId: 'scene-a',
    nodeSettingsRequest: request + 1,
    canUndo: false,
  })
  const selected = view.editorProjection()
  for (const args of [
    { id: 'gone' },
    { id: 'dialogue', projectId: 'old-project' },
  ]) {
    let rejected: unknown
    await act(async () => {
      rejected = await intent('editor.select', args)
    })
    expect(rejected).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
    expect(view.editorProjection()).toEqual(selected)
  }
})

it('blank canvas clears the property target without issuing another presentation or leaving AI', async () => {
  const view = nativeEditorFixture(nativeListProject())
  fireEvent.click(view.getByTestId('rf__node-dialogue'))
  expect(view.editorProjection().editingNodeId).toBe('dialogue')
  const request = view.editorProjection().nodeSettingsRequest
  await act(async () => {
    await intent('editor.ai')
  })
  const pane = view.container.querySelector('.react-flow__pane')
  if (!pane) throw new Error('Missing real React Flow pane')
  fireEvent.click(pane)
  expect(view.editorProjection()).toMatchObject({
    aiOpen: true,
    editingNodeId: null,
    selected: null,
    nodeSettingsRequest: request,
    canUndo: false,
  })
})

it('modified selection, inline inputs and connection handles preserve the AI mode', async () => {
  const view = nativeEditorFixture(nativeListProject())
  await act(async () => {
    await intent('editor.ai')
  })
  const request = view.editorProjection().nodeSettingsRequest
  for (const modifiers of [
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
  ]) {
    fireEvent.click(view.getByTestId('rf__node-dialogue'), modifiers)
    expect(view.editorProjection()).toMatchObject({
      aiOpen: true,
      nodeSettingsRequest: request,
    })
  }
  fireEvent.doubleClick(
    within(view.getByTestId('rf__node-scene-a')).getByText('天台'),
  )
  fireEvent.click(view.getByLabelText('场景名称'))
  const handle = view
    .getByTestId('rf__node-scene-a')
    .querySelector('.react-flow__handle')
  if (!handle) throw new Error('Missing real React Flow connection handle')
  fireEvent.click(handle)
  expect(view.editorProjection()).toMatchObject({
    aiOpen: true,
    nodeSettingsRequest: request,
  })
})

it('dragging a native node changes its position and history without opening properties or leaving AI', async () => {
  vi.useFakeTimers()
  const view = nativeEditorFixture({
    ...PROJECT,
    nodes: [{ ...SCENE, width: 240, height: 120 }],
    viewport: { x: 0, y: 0, zoom: 1 },
  })
  await act(async () => {
    await intent('editor.ai')
  })
  const node = view.getByTestId('rf__node-scene-a')
  const request = view.editorProjection().nodeSettingsRequest
  fireEvent.mouseDown(node, {
    clientX: 10,
    clientY: 10,
    button: 0,
    buttons: 1,
    view: window,
  })
  fireEvent.mouseMove(window, {
    clientX: 12,
    clientY: 12,
    buttons: 1,
    view: window,
  })
  fireEvent.mouseMove(window, {
    clientX: 66,
    clientY: 66,
    buttons: 1,
    view: window,
  })
  fireEvent.mouseUp(window, {
    clientX: 66,
    clientY: 66,
    button: 0,
    view: window,
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(node.style.transform).toBe('translate(44px,44px)')
  expect(view.editorProjection()).toMatchObject({
    aiOpen: true,
    editingNodeId: null,
    nodeSettingsRequest: request,
    canUndo: true,
  })
  expect((await exportedDocument()).graph.nodes[0].layout.position).toEqual({
    x: 44,
    y: 44,
  })
  await act(async () => {
    await intent('editor.undo')
  })
  expect(node.style.transform).toBe('translate(0px,0px)')
  expect(view.editorProjection()).toMatchObject({
    aiOpen: true,
    nodeSettingsRequest: request,
    canUndo: false,
  })
})

it.each(['scene', 'beat', 'dialogue', 'branch', 'shot', 'image'])(
  'native create %s persists one typed node and remains undoable',
  async (nodeType) => {
    const view = nativeEditorFixture()
    expect(await nativeCommand('editor.create', { nodeType })).toEqual({
      ok: null,
    })
    const nodes = (await exportedDocument()).graph.nodes
    expect(nodes).toHaveLength(2)
    expect(
      nodes.find((node: { id: string }) => node.id !== 'scene-a'),
    ).toMatchObject({ type: nodeType })
    expect(view.editorProjection().canUndo).toBe(true)
    await nativeCommand('editor.undo')
    expect(
      (await exportedDocument()).graph.nodes.map(
        (node: { id: string }) => node.id,
      ),
    ).toEqual(['scene-a'])
  },
)

it('native duplicate owns a new identity and undo preserves the original scene', async () => {
  nativeEditorFixture()
  const before = await exportedDocument()
  expect(await nativeCommand('editor.duplicate', { id: 'scene-a' })).toEqual({
    ok: null,
  })
  const nodes = (await exportedDocument()).graph.nodes
  const duplicate = nodes.find((node: { id: string }) => node.id !== 'scene-a')
  expect(duplicate).toMatchObject({
    type: 'scene',
    data: { spec: { synopsis: '开场' } },
  })
  expect(duplicate.id).not.toBe('scene-a')
  await nativeCommand('editor.undo')
  expect(await exportedDocument()).toEqual(before)
})

it('native align updates selected positions as one undo unit', async () => {
  nativeEditorFixture({
    ...PROJECT,
    nodes: [
      {
        ...SCENE,
        selected: true,
        width: 240,
        height: 120,
        position: { x: 0, y: 10 },
      },
      {
        ...SCENE,
        id: 'scene-b',
        selected: true,
        width: 240,
        height: 120,
        position: { x: 80, y: 200 },
      },
    ],
  })
  const before = await exportedDocument()
  expect(await nativeCommand('editor.align', { alignment: 'left' })).toEqual({
    ok: null,
  })
  expect(
    (await exportedDocument()).graph.nodes.map(
      (node: { layout: { position: unknown } }) => node.layout.position,
    ),
  ).toEqual([
    { x: 0, y: 10 },
    { x: 0, y: 200 },
  ])
  await nativeCommand('editor.undo')
  expect(await exportedDocument()).toEqual(before)
})

it.each([
  { kind: 'location', bucket: 'locations', patch: { name: '码头' } },
  {
    kind: 'document',
    bucket: 'documents',
    patch: { title: '小传', body: '正文' },
  },
])(
  'native $kind create/update/delete share the real settings history',
  async ({ kind, bucket, patch }) => {
    nativeEditorFixture()
    expect(await nativeCommand('editor.entityCreate', { kind })).toEqual({
      ok: null,
    })
    const created = await exportedDocument()
    const id = Object.keys(created.settings[bucket])[0]
    const original = created.settings[bucket][id]
    expect(id).toBeTypeOf('string')
    expect(
      await nativeCommand('editor.entityUpdate', { kind, id, patch }),
    ).toEqual({ ok: null })
    expect((await exportedDocument()).settings[bucket][id]).toMatchObject(patch)
    await nativeCommand('editor.undo')
    expect((await exportedDocument()).settings[bucket][id]).toEqual(original)
    expect(await nativeCommand('editor.entityDelete', { kind, id })).toEqual({
      ok: null,
    })
    expect((await exportedDocument()).settings[bucket]).toEqual({})
    await nativeCommand('editor.undo')
    expect((await exportedDocument()).settings[bucket][id]).toEqual(original)
  },
)

it('native episode focus is view-only while renaming is persistent and undoable', async () => {
  const view = nativeEditorFixture()
  const before = await exportedDocument()
  expect(await nativeCommand('editor.episodeFocus', { episode: 1 })).toEqual({
    ok: null,
  })
  expect(view.editorProjection()).toMatchObject({
    focusedEpisode: 1,
    canUndo: false,
  })
  expect(await exportedDocument()).toEqual(before)
  await nativeCommand('editor.episodeFocus', { episode: null })
  expect(view.editorProjection()).toMatchObject({
    focusedEpisode: null,
    canUndo: false,
  })
  expect(
    await nativeCommand('editor.episodeRename', { episode: 1, title: '序章' }),
  ).toEqual({ ok: null })
  expect((await exportedDocument()).episodeTitles).toEqual({ '1': '序章' })
  await nativeCommand('editor.undo')
  expect(await exportedDocument()).toEqual(before)
})

it('invalid native command arguments reject without changing the document or history', async () => {
  const view = nativeEditorFixture({
    ...PROJECT,
    settings: {
      characters: [{ id: 'c', name: '角色', gradient: 'blue' }],
      locations: [],
    },
  })
  const before = await exportedDocument()
  const cases = [
    ['editor.create', { nodeType: 'unknown' }],
    ['editor.align', { alignment: '' }],
    ['editor.align', { alignment: 'diagonal' }],
    ['editor.entityCreate', { kind: 'audio' }],
    ['editor.entityUpdate', { kind: 'character', id: 'c', patch: { name: 7 } }],
    ['editor.exportPreview', { format: 'yaml' }],
    ['editor.episodeFocus', { episode: 0 }],
    ['editor.episodeRename', { episode: 1.5, title: 'invalid' }],
    ['editor.episodeRename', { episode: 1, title: 7 }],
    ['editor.unknown', {}],
  ] as const
  for (const [command, args] of cases) {
    expect(await nativeCommand(command, args), command).toMatchObject({
      error: { code: 'PW_INTENT_FAILED', message: expect.any(String) },
    })
    expect(await exportedDocument(), command).toEqual(before)
    expect(view.editorProjection().canUndo, command).toBe(false)
  }
})

it('sceneNo clears independently, keeps content and topology, and has field-specific history (#933)', async () => {
  nativeEditorFixture({
    ...PROJECT,
    nodes: [
      { ...SCENE, data: { ...SCENE.data, sceneNo: 7, episodeNo: 2 } },
      { ...SCENE, id: 'other' },
    ],
    edges: [
      {
        id: 'edge',
        source: SCENE.id,
        target: 'other',
        className: 'pw-edge-sequence',
      },
    ],
  })
  const before = await exportedDocument()
  await act(async () => {
    expect(
      await intent('editor.clearNodeField', { id: SCENE.id, field: 'sceneNo' }),
    ).toEqual({ ok: null })
  })
  const cleared = await exportedDocument()
  expect(cleared.graph.nodes[0].data.spec.sceneNo).toBeUndefined()
  expect(cleared.graph.nodes[0].data.meta.episodeNo).toBe(2)
  const expected = structuredClone(before)
  delete expected.graph.nodes[0].data.spec.sceneNo
  expect(cleared).toEqual(expected)
  await act(async () => {
    await intent('editor.clearNodeField', { id: SCENE.id, field: 'episodeNo' })
  })
  expect(
    (await exportedDocument()).graph.nodes[0].data.meta.episodeNo,
  ).toBeUndefined()
  await act(async () => {
    await intent('editor.undo')
  })
  expect(await exportedDocument()).toEqual(cleared)
  await act(async () => {
    await intent('editor.undo')
  })
  expect(await exportedDocument()).toEqual(before)
  await act(async () => {
    await intent('editor.redo')
  })
  expect(await exportedDocument()).toEqual(cleared)
  await act(async () => {
    await intent('editor.redo')
  })
  expect(
    (await exportedDocument()).graph.nodes[0].data.meta.episodeNo,
  ).toBeUndefined()
  await act(async () => {
    await intent('editor.patchNode', { id: SCENE.id, patch: { sceneNo: 8 } })
  })
  expect((await exportedDocument()).graph.nodes[0].data.spec.sceneNo).toBe(8)
})

it('repeated scene clearing is a no-op and rejects stale or foreign targets (#933)', async () => {
  nativeEditorFixture(nativeListProject())
  await act(async () => {
    await intent('editor.clearNodeField', { id: SCENE.id, field: 'sceneNo' })
  })
  const cleared = await exportedDocument()
  await act(async () => {
    await intent('editor.clearNodeField', { id: SCENE.id, field: 'sceneNo' })
  })
  expect(await exportedDocument()).toEqual(cleared)
  await act(async () => {
    await intent('editor.undo')
  })
  expect((await exportedDocument()).graph.nodes[0].data.spec.sceneNo).toBe(1)
  for (const args of [
    { id: 'dialogue', field: 'sceneNo' },
    { id: SCENE.id, field: 'shotNo' },
    { id: SCENE.id, field: 'sceneNo', projectId: 'stale' },
    { id: 'deleted', field: 'sceneNo' },
  ]) {
    const before = await exportedDocument()
    await act(async () => {
      expect(await intent('editor.clearNodeField', args)).toMatchObject({
        error: { code: 'PW_INTENT_FAILED' },
      })
    })
    expect(await exportedDocument()).toEqual(before)
  }
})
