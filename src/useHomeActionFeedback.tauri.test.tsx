// @vitest-environment happy-dom
/** 重命名失败反馈与真实保存链集成：只替换 IPC，验证自动重试及退出冲刷恢复。 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useHomeActionFeedback } from './useHomeActionFeedback'
import { flushPendingProjectSaves } from './projectStore/saveChain'
import { serializeProject } from './model/convert'
import type { ProjectContent } from './model/content'
import type { ProjectDocument } from './model/document'

const documents = new Map<string, ProjectDocument>()
const unavailable = new Set<string>()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (
    command: string,
    args: { id: string; doc: ProjectDocument },
  ) => {
    if (command === 'list_projects') {
      return [...documents.values()].map(({ project }) => ({
        id: project.id,
        name: project.name,
        updated_at: project.updatedAt,
        scene_count: 0,
        ending_count: 0,
      }))
    }
    if (command === 'save_project') {
      if (unavailable.has(args.id)) throw new Error('暂时只读')
      documents.set(args.id, structuredClone(args.doc))
      return
    }
    throw new Error(`未编排命令：${command}`)
  },
}))

let store: typeof import('./projectStore').projectStore
let summaries: typeof import('./useProjectSummaries')
const original: ProjectContent = {
  name: '旧名',
  nodes: [],
  edges: [],
  settings: { characters: [], locations: [] },
}

beforeAll(async () => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: {},
    configurable: true,
  })
  ;({ projectStore: store } = await import('./projectStore'))
  summaries = await import('./useProjectSummaries')
})

beforeEach(() => {
  vi.useFakeTimers()
  documents.clear()
  documents.set('p1', serializeProject(original, 'p1'))
  unavailable.add('p1')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  cleanup()
  unavailable.clear()
  await flushPendingProjectSaves()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 以生产保存入口建立真实失败登记，App 接线另由 App.test.tsx 回归验证。 */
async function failedRename() {
  const hook = renderHook(() => ({
    feedback: useHomeActionFeedback(),
    list: summaries.useProjectSummaries(() => true),
  }))
  const renamed = { ...original, name: '新名' }
  await act(async () => {
    const feedback = hook.result.current.feedback
    const seq = feedback.begin()
    feedback.watchSave(seq, renamed)
    try {
      await store.save('p1', renamed)
    } catch (err) {
      feedback.fail(seq, {
        action: 'rename',
        targetId: 'p1',
        targetName: '新名',
        detail: String(err),
      })
    }
  })
  expect(hook.result.current.feedback.failure?.error.action).toBe('rename')
  expect(documents.get('p1')?.project.name).toBe('旧名')
  return hook
}

// 回归目标：定时器或退出冲刷的真实落盘成功必须同步清除当前失败反馈。
it.each(['timer', 'exit-flush'] as const)(
  '%s 恢复同一文档后清除错误并刷新名称',
  async (path) => {
    const { result } = await failedRename()
    unavailable.clear()
    await act(async () => {
      if (path === 'timer') await vi.advanceTimersByTimeAsync(5000)
      else await flushPendingProjectSaves()
    })
    expect(documents.get('p1')?.project.name).toBe('新名')
    expect(result.current.list.projects[0]?.name).toBe('新名')
    expect(result.current.feedback.failure).toBeNull()
  },
)

// 回归目标：仅仅执行了重试不等于恢复，持久化失败期间不得隐藏横幅。
it('自动重试继续失败时保留诊断，后续成功再清除', async () => {
  const { result } = await failedRename()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(documents.get('p1')?.project.name).toBe('旧名')
  expect(result.current.feedback.failure?.error.detail).toMatch(/暂时只读/)
  unavailable.clear()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(documents.get('p1')?.project.name).toBe('新名')
  expect(result.current.feedback.failure).toBeNull()
})
