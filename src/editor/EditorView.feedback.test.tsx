// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EditorView } from './EditorView'
import { useEditorController } from './useEditorController'
import type { EditorProjectContent } from './useEditorDocument'
import type { ProjectContent } from '../model/content'

/** Exercise the same native intent and React owner used by the desktop outline. */
const host = window as Window & {
  __pwNativeHost?: unknown
  __pwNativeIntent?: (request: unknown) => Promise<unknown>
  webkit?: unknown
}
const PROJECT: EditorProjectContent = {
  id: 'feedback-project',
  name: '反馈测试',
  nodes: ['a', 'b', 'isolated'].map((id) => ({
    id,
    type: 'scene',
    position: { x: 0, y: 0 },
    data: {
      name: id,
      sceneNo: 1,
      interior: false,
      time: '夜',
      synopsis: '',
      characterIds: [],
    },
  })),
  edges: [
    { id: 'ab', source: 'a', target: 'b', className: 'pw-edge-sequence' },
  ],
  settings: { characters: [], locations: [] },
}
let requestId = 0

/** Keep document, persistence, alert markup and outline handling on production paths. */
function mountEditor(
  onSave = vi.fn<(doc: ProjectContent) => void | Promise<void>>(),
) {
  host.__pwNativeHost = {
    kind: 'swift',
    protocolVersion: 1,
    sessionId: 'feedback',
  }
  host.webkit = {
    messageHandlers: {
      canvasHost: { postMessage: vi.fn() },
      plotweaveHost: { postMessage: async () => ({ ok: {} }) },
    },
  }
  return render(
    <EditorView
      project={PROJECT}
      onSave={onSave}
      onBackHome={() => undefined}
      onRenameProject={() => undefined}
    />,
  )
}

/** Send a real native command with explicit session and project targeting. */
async function intent(command: string, args: Record<string, unknown> = {}) {
  let result: unknown
  await act(async () => {
    result = await host.__pwNativeIntent?.({
      protocolVersion: 1,
      sessionId: 'feedback',
      requestId: String(++requestId),
      command,
      args: { projectId: PROJECT.id, ...args },
    })
  })
  return result
}

/** This unsafe seam produces the screenshot's refusal without altering the graph. */
function refuseMove() {
  return intent('editor.outlineMove', {
    id: 'a',
    target: { kind: 'row', anchorId: 'isolated', position: 'after' },
  })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete host.__pwNativeHost
  delete host.webkit
})

it('recovery errors keep their own slot when completed canvas feedback expires', async () => {
  vi.useFakeTimers()
  const { result } = renderHook(() =>
    useEditorController({
      project: PROJECT,
      onSave: () => undefined,
      screenToFlowPosition: (position) => position,
      fitView: async () => true,
    }),
  )
  act(() => {
    result.current.history.push({
      undo: () => undefined,
      redo: () => undefined,
      redoGuard: async () => {
        throw new Error('恢复资产后重试')
      },
    })
    result.current.history.undo()
  })
  await act(async () => {
    result.current.history.onRedo()
    await Promise.resolve()
  })
  expect(result.current.actionError).toContain('恢复资产后重试')
  act(() =>
    result.current.graph.outlineDrop('a', {
      kind: 'row',
      anchorId: 'isolated',
      position: 'after',
    }),
  )
  expect(result.current.actionFeedback).toContain('大纲拖拽未执行')
  act(() => vi.advanceTimersByTime(10_000))
  expect(result.current.actionFeedback).toBeNull()
  expect(result.current.actionError).toContain('恢复资产后重试')
  expect(result.current.history.canRedo).toBe(true)
})

it('expires the completed outline refusal after a readable interval (#930)', async () => {
  const view = mountEditor()
  vi.useFakeTimers()
  const before = await intent('editor.exportPreview', { format: 'json' })
  await refuseMove()
  expect(view.getByRole('alert').textContent).toContain('大纲拖拽未执行')
  expect(view.getByRole('alert').textContent).toContain('请先在画布上调整连线')
  act(() => vi.advanceTimersByTime(7_999))
  expect(view.getByRole('alert')).toBeTruthy()
  act(() => vi.advanceTimersByTime(1))
  expect(view.queryByRole('alert')).toBeNull()
  expect(await intent('editor.exportPreview', { format: 'json' })).toEqual(
    before,
  )
})

it('repeated refusals restart the timer and successful editing remains saved and undoable', async () => {
  const onSave = vi.fn()
  const view = mountEditor(onSave)
  vi.useFakeTimers()
  await refuseMove()
  act(() => vi.advanceTimersByTime(6_000))
  await refuseMove()
  act(() => vi.advanceTimersByTime(2_000))
  expect(view.getByRole('alert').textContent).toContain('未执行')
  await intent('editor.patchNode', { id: 'b', patch: { synopsis: '更新' } })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700)
  })
  expect(
    onSave.mock.lastCall?.[0].nodes.find(
      (node: { id: string }) => node.id === 'b',
    ).data.synopsis,
  ).toBe('更新')
  act(() => vi.advanceTimersByTime(5_300))
  expect(view.queryByRole('alert')).toBeNull()
  await intent('editor.undo')
  const exported = (await intent('editor.exportPreview', {
    format: 'json',
  })) as { ok: { text: string } }
  expect(
    JSON.parse(exported.ok.text).graph.nodes.find(
      (node: { id: string }) => node.id === 'b',
    ).data.spec.synopsis,
  ).toBe('')
})

it('save failures survive transient expiry and clear only after real recovery', async () => {
  const onSave = vi
    .fn<(doc: ProjectContent) => void | Promise<void>>()
    .mockRejectedValue(new Error('磁盘只读'))
  const view = mountEditor(onSave)
  vi.useFakeTimers()
  await refuseMove()
  await intent('editor.patchNode', { id: 'b', patch: { synopsis: '保留' } })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000)
  })
  expect(view.getByRole('alert').textContent).toContain('自动保存失败')
  expect(view.getByRole('alert').textContent).toContain('磁盘只读')
  expect(view.queryByText(/大纲拖拽未执行/)).toBeNull()
  onSave.mockResolvedValue(undefined)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000)
  })
  expect(view.queryByRole('alert')).toBeNull()
  expect(view.getByLabelText('画布保存状态').textContent).toBe('已保存')
})

it('an in-flight save keeps its progress state after completed feedback expires', async () => {
  let finish!: () => void
  const onSave = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const view = mountEditor(onSave)
  vi.useFakeTimers()
  await refuseMove()
  await intent('editor.patchNode', { id: 'b', patch: { synopsis: '进行中' } })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(view.queryByRole('alert')).toBeNull()
  expect(view.getByLabelText('画布保存状态').textContent).toBe('保存中…')
  await act(async () => {
    finish()
    await Promise.resolve()
  })
  expect(view.getByLabelText('画布保存状态').textContent).toBe('已保存')
})
