// @vitest-environment happy-dom
/** 已开始的 Web 资产业务跨 IPC、React 提交与真实项目文件保存后才能退出。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DragEvent } from 'react'
import { useExitFlush } from './useExitFlush'
import {
  useEditorDocument,
  type EditorProjectContent,
} from './editor/useEditorDocument'
import { useLibraryAssetDrop } from './editor/useLibraryAssetDrop'
import { useEditorPersistence } from './editor/useEditorPersistence'
import { PW_LIBRARY_ASSET_MIME } from './editor/dragDrop'
import { enqueueSave } from './projectStore/saveChain'
import { serializeProject } from './model/convert'
import type { ProjectDocument } from './model/document'
import { mergeNodeData } from './editor/nodes/patch'

let root: string
const project: EditorProjectContent = {
  id: 'web-asset-exit',
  name: '异步资产业务',
  edges: [],
  settings: { characters: [], locations: [] },
  nodes: [
    {
      id: 'shot',
      type: 'shot',
      position: { x: 0, y: 0 },
      data: { shotNo: 1, size: '', picture: '', prompt: '', refs: [] },
    },
  ],
}
const asset = {
  id: 'imported',
  relPath: 'assets/imported.png',
  mime: 'image/png',
  source: 'upload',
  createdAt: '2026-10-12T00:00:00Z',
} as const
let onRequest: (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pw-web-exit-'))
  await writeFile(
    join(root, 'project.json'),
    JSON.stringify(serializeProject(project, project.id)),
  )
  Object.assign(window, {
    __pwNativeHost: {
      kind: 'swift',
      protocolVersion: 1,
      sessionId: 'web-work-session',
    },
    webkit: {
      messageHandlers: {
        plotweaveHost: {
          postMessage: async ({
            command,
            args = {},
          }: {
            command: string
            args?: Record<string, unknown>
          }) => {
            if (command === 'save_project') {
              await writeFile(
                join(root, 'project.json'),
                JSON.stringify(args.doc),
              )
              return { ok: null }
            }
            return onRequest(command, args)
          },
        },
      },
    },
  })
})
afterEach(async () => {
  cleanup()
  Reflect.deleteProperty(window, '__pwNativeHost')
  Reflect.deleteProperty(window, 'webkit')
  await rm(root, { recursive: true, force: true })
})

/** 生产状态 owner、资产导入编排与保存协调器接线，断言下游真实磁盘内容。 */
function useAssetEditor() {
  const blocked = useExitFlush()
  const doc = useEditorDocument(project)
  useEditorPersistence(project, doc, (next) => enqueueSave(project.id, next))
  const drop = useLibraryAssetDrop({
    projectId: project.id,
    nodesRef: doc.nodesRef,
    addAsset: (next) =>
      doc.setAssets((old) => ({ byId: { ...old?.byId, [next.id]: next } })),
    removeAsset: (id) =>
      doc.setAssets((old) => ({
        byId: Object.fromEntries(
          Object.entries(old?.byId ?? {}).filter(([key]) => key !== id),
        ),
      })),
    applyDataPatch: (id, patch) =>
      doc.setNodes((old) =>
        old.map((node) =>
          node.id === id && node.type === 'shot' && patch.nodeType === 'shot'
            ? mergeNodeData(node, patch.patch)
            : node,
        ),
      ),
    pushHistory: () => {},
    onError: (message) => {
      throw new Error(message)
    },
  })
  return { doc, drop, blocked }
}

/** 协议载荷命中真实 DOM 节点，事件替身只替代浏览器 DataTransfer。 */
function assetDrop(): DragEvent {
  const target = document.createElement('div')
  target.className = 'react-flow__node'
  target.dataset.id = 'shot'
  return {
    target,
    preventDefault: () => {},
    dataTransfer: {
      getData: (type: string) =>
        type === PW_LIBRARY_ASSET_MIME
          ? JSON.stringify({
              id: 'library',
              name: '人物.png',
              kind: 'character',
              mime: 'image/png',
            })
          : '',
    },
  } as unknown as DragEvent
}

it('退出前的 Web 导入尚未回执时不批准，交付结果随真实项目文件保存后才批准', async () => {
  let release!: () => void
  const imported = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = false
  let ready = false
  let approved: ProjectDocument | null = null
  onRequest = async (command) => {
    if (command === 'acknowledge_quit_listener') ready = true
    if (command === 'import_project_asset_from_library') {
      started = true
      await imported
      await writeFile(join(root, 'imported.png'), 'synthetic-media')
      return { ok: asset }
    }
    if (command === 'validate_project_asset') return { ok: asset }
    if (command === 'app_exit')
      approved = JSON.parse(
        await readFile(join(root, 'project.json'), 'utf8'),
      ) as ProjectDocument
    return { ok: null }
  }
  const view = renderHook(useAssetEditor)
  await vi.waitFor(() => expect(ready).toBe(true))
  act(() => view.result.current.drop(assetDrop()))
  await vi.waitFor(() => expect(started).toBe(true))
  const host = window as Window & {
    __pwDispatchHostEvent?: (name: string, payload: unknown) => void
  }
  await act(async () => {
    host.__pwDispatchHostEvent?.('app-quit-requested', null)
    await Promise.resolve()
  })
  expect(approved).toBeNull()
  expect(document.body.inert).toBe(true)
  await act(async () => {
    release()
    await imported
  })
  await vi.waitFor(() => expect(approved).not.toBeNull())
  const saved = JSON.parse(
    await readFile(join(root, 'project.json'), 'utf8'),
  ) as ProjectDocument
  expect(saved.assets?.byId.imported).toEqual(asset)
  expect(saved.graph.nodes[0]?.data.spec).toMatchObject({
    refs: [{ kind: 'character', assetId: 'imported' }],
  })
  expect(await readFile(join(root, 'imported.png'), 'utf8')).toBe(
    'synthetic-media',
  )
  expect(approved).toEqual(saved)
})

it('已冲刷后的最终批准失败解除封口，新稿实际保存后明确重试可退出', async () => {
  let ready = false
  let attempts = 0
  let cancellations = 0
  let approved: ProjectDocument | null = null
  onRequest = async (command, args) => {
    if (command === 'acknowledge_quit_listener') ready = true
    if (command === 'app_exit' && args.cancel === true) cancellations += 1
    else if (command === 'app_exit') {
      attempts += 1
      if (attempts === 1)
        return {
          error: { code: 'PW_FIXTURE_EXIT_DENIED', message: 'fixture denied' },
        }
      approved = JSON.parse(
        await readFile(join(root, 'project.json'), 'utf8'),
      ) as ProjectDocument
    }
    return { ok: null }
  }
  const view = renderHook(useAssetEditor)
  await vi.waitFor(() => expect(ready).toBe(true))
  const host = window as Window & {
    __pwDispatchHostEvent?: (name: string, payload: unknown) => void
  }
  act(() => {
    view.result.current.doc.setEpisodeTitles({ 1: '第一次退出稿' })
    host.__pwDispatchHostEvent?.('app-quit-requested', null)
  })
  await vi.waitFor(() => expect(cancellations).toBe(1))
  expect(view.result.current.blocked).toContain('fixture denied')
  expect(document.body.inert).toBe(false)
  expect(approved).toBeNull()
  act(() => {
    view.result.current.doc.setEpisodeTitles({ 1: '失败后继续编辑稿' })
    host.__pwDispatchHostEvent?.('app-quit-requested', null)
  })
  await vi.waitFor(() => expect(approved).not.toBeNull())
  const saved = JSON.parse(
    await readFile(join(root, 'project.json'), 'utf8'),
  ) as ProjectDocument
  expect(saved.episodeTitles).toEqual({ 1: '失败后继续编辑稿' })
  expect(approved).toEqual(saved)
  expect(attempts).toBe(2)
})
