// @vitest-environment happy-dom
/** R32 exercises actual App failure owners through the production native intent boundary. */
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from './App'
import { projectStore, type ProjectContent } from './projectStore'

vi.mock('./projectStore', () => ({
  projectStore: {
    list: vi.fn(),
    create: vi.fn(),
    load: vi.fn(),
    save: vi.fn(),
    duplicate: vi.fn(),
    delete: vi.fn(),
    loadAiSession: vi.fn(),
    onProjectSaved: () => () => {},
    onAiSessionSaved: () => () => {},
    onAiSessionSaveFailed: () => () => {},
  },
}))
vi.mock('./editor/EditorView', () => ({ EditorView: () => <div>editor</div> }))
vi.mock('./useExitFlush', () => ({ useExitFlush: () => null }))

/** The isolated store models observable mutations, with failures injected at its owning boundary. */
const store = vi.mocked(projectStore)
const documents = new Map<string, ProjectContent>()
const nativeWindow = window as Window & {
  __pwNativeHost?: unknown
  __pwNativeIntent?: (request: unknown) => Promise<unknown>
  webkit?: unknown
}
const postMessage = vi.fn()
let requestNo = 0

/** Sends a new identity through the real bridge; retries do not reuse transport identities. */
async function intent(command: string, args: Record<string, unknown> = {}) {
  let result: unknown
  await act(async () => {
    result = await request(command, args)
  })
  return result
}

/** Allows concurrent admission within one React turn to exercise the recovery claim before projection updates. */
function request(command: string, args: Record<string, unknown> = {}) {
  return nativeWindow.__pwNativeIntent?.({
    protocolVersion: 1,
    sessionId: 'home-recovery',
    requestId: String(++requestNo),
    command,
    args,
  })
}

/** Reads the latest native projection rather than inferring success from a mocked call count. */
function projection() {
  const states = postMessage.mock.calls
    .map(([value]) => value.projection?.app)
    .filter(Boolean)
  return states[states.length - 1]
}

/** Supplies the actual summary contract while keeping all fixture metadata synthetic. */
function metadata(id: string, name: string) {
  return { id, name, sceneCount: 0, updatedAt: '2026-10-12T00:00:00.000Z' }
}

beforeEach(async () => {
  vi.resetAllMocks()
  requestNo = 0
  documents.clear()
  documents.set('p1', {
    name: '原名',
    nodes: [],
    edges: [],
    settings: { characters: [], locations: [] },
  })
  store.list.mockImplementation(async () =>
    [...documents].map(([id, doc]) => metadata(id, doc.name)),
  )
  store.load.mockImplementation(async (id) =>
    structuredClone(documents.get(id)!),
  )
  store.save.mockImplementation(async (id, doc) => {
    documents.set(id, doc)
  })
  store.delete.mockImplementation(async (id) => {
    documents.delete(id)
  })
  store.create.mockImplementation(async (name) => {
    documents.set('new', { ...structuredClone(documents.get('p1')!), name })
    return metadata('new', name)
  })
  store.duplicate.mockImplementation(async (id) => {
    const doc = structuredClone(documents.get(id)!)
    documents.set('copy', doc)
    return metadata('copy', doc.name)
  })
  store.loadAiSession.mockResolvedValue({
    session: { schemaVersion: 1, entries: [] },
    repairError: null,
  })
  nativeWindow.__pwNativeHost = {
    kind: 'swift',
    protocolVersion: 1,
    sessionId: 'home-recovery',
  }
  nativeWindow.webkit = { messageHandlers: { canvasHost: { postMessage } } }
  render(<App />)
  await waitFor(() => expect(projection()?.loading).toBe(false))
})

afterEach(() => {
  cleanup()
  delete nativeWindow.__pwNativeHost
  delete nativeWindow.webkit
  vi.restoreAllMocks()
})

it('重命名失败后的原生重试实际保存原稿，而非仅刷新列表', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  store.load.mockRejectedValueOnce(new Error('暂时不可读'))
  await intent('app.rename', { id: 'p1', name: '原生提交的稿名' })
  await intent('app.retry')
  expect(documents.get('p1')?.name).toBe('原生提交的稿名')
  expect(projection().error).toBeNull()
})

it.each(['open', 'create', 'rename', 'duplicate', 'delete'] as const)(
  '原生恢复 %s 的原操作和参数',
  async (action) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const operation =
      action === 'open' || action === 'rename' ? store.load : store[action]
    operation.mockRejectedValueOnce(new Error('隔离失败'))
    await intent(`app.${action}`, { id: 'p1', name: '保留的新名' })
    await waitFor(() => expect(projection()?.error).toContain('隔离失败'))
    expect(projection().recovery).toMatchObject({ action, canRetry: true })
    await intent('app.retry', { recoveryId: projection().recovery.id })
    await waitFor(() => expect(projection().error).toBeNull())
    if (action === 'open')
      expect(projection()).toMatchObject({
        route: 'editor',
        project: { id: 'p1' },
      })
    if (action === 'create')
      expect(projection()).toMatchObject({
        route: 'editor',
        project: { id: 'new' },
      })
    if (action === 'rename')
      expect(documents.get('p1')?.name).toBe('保留的新名')
    if (action === 'duplicate')
      expect([...documents.keys()]).toEqual(['p1', 'copy'])
    if (action === 'delete') expect(documents.has('p1')).toBe(false)
    warn.mockRestore()
  },
)

it('读取失败只重读列表，不重做项目操作', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  store.list.mockRejectedValueOnce(new Error('枚举失败'))
  await intent('app.retry')
  expect(projection()).toMatchObject({
    recovery: { action: 'load', canRetry: true },
  })
  await intent('app.retry', { recoveryId: projection().recovery.id })
  expect(projection().error).toBeNull()
  expect([...documents.keys()]).toEqual(['p1'])
  expect(store.create).not.toHaveBeenCalled()
  warn.mockRestore()
})

it.each(['present', 'unknown'] as const)(
  '创建族 %s 不开放盲重试',
  async (state) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.duplicate.mockImplementationOnce(async () => {
      if (state === 'present')
        documents.set('partial', structuredClone(documents.get('p1')!))
      else store.list.mockRejectedValueOnce(new Error('对账失败'))
      throw new Error('复制失败')
    })
    await intent('app.duplicate', { id: 'p1' })
    if (state === 'unknown') await intent('app.retry')
    expect(projection().recovery).toMatchObject({
      action: 'duplicate',
      canRetry: false,
    })
    const before = [...documents.keys()]
    expect(
      await intent('app.retry', { recoveryId: projection().recovery.id }),
    ).toHaveProperty('error')
    expect([...documents.keys()]).toEqual(before)
    expect(store.duplicate).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  },
)

it('旧恢复身份不能重做新的失败，成功后也不能复活操作', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  store.load.mockRejectedValueOnce(new Error('旧重命名失败'))
  await intent('app.rename', { id: 'p1', name: '旧稿' })
  const old = projection().recovery.id
  store.delete.mockRejectedValueOnce(new Error('新删除失败'))
  await intent('app.delete', { id: 'p1' })
  const current = projection().recovery.id
  expect(await intent('app.retry', { recoveryId: old })).toHaveProperty('error')
  expect(documents.has('p1')).toBe(true)
  await intent('app.retry', { recoveryId: current })
  expect(documents.has('p1')).toBe(false)
  expect(await intent('app.retry', { recoveryId: current })).toHaveProperty(
    'error',
  )
  expect(store.delete).toHaveBeenCalledTimes(2)
  warn.mockRestore()
})

it('同一恢复身份的并发点击只执行一次非幂等操作', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  store.duplicate.mockRejectedValueOnce(new Error('未创建副本'))
  await intent('app.duplicate', { id: 'p1' })
  const recoveryId = projection().recovery.id
  let results: unknown[] = []
  await act(async () => {
    results = await Promise.all([
      request('app.retry', { recoveryId }),
      request('app.retry', { recoveryId }),
    ])
  })
  expect(
    results.filter(
      (result) => result && typeof result === 'object' && 'error' in result,
    ),
  ).toHaveLength(1)
  expect(store.duplicate).toHaveBeenCalledTimes(2)
  expect([...documents.keys()]).toEqual(['p1', 'copy'])
})

it('列表重读连续返回同一诊断后仍允许明确恢复', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  store.list.mockRejectedValueOnce(new Error('持续枚举失败'))
  await intent('app.retry')
  store.list.mockRejectedValueOnce(new Error('持续枚举失败'))
  await intent('app.retry', { recoveryId: projection().recovery.id })
  expect(projection().error).toContain('持续枚举失败')
  expect(
    await intent('app.retry', { recoveryId: projection().recovery.id }),
  ).toHaveProperty('ok')
  expect(projection().error).toBeNull()
  expect([...documents.keys()]).toEqual(['p1'])
})

it('列表诊断优先恢复列表，明确刷新不消费未恢复的变更', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  store.load.mockRejectedValueOnce(new Error('重命名失败'))
  await intent('app.rename', { id: 'p1', name: '仍保留的稿名' })
  const old = projection().recovery.id
  store.list.mockRejectedValueOnce(new Error('列表失败'))
  await intent('app.retry', { recoveryId: null })
  expect(projection().recovery.action).toBe('load')
  await intent('app.retry', { recoveryId: projection().recovery.id })
  expect(projection().recovery.action).toBe('rename')
  expect(documents.get('p1')?.name).toBe('原名')
  expect(await intent('app.retry', { recoveryId: old })).toHaveProperty('error')
  await intent('app.retry', { recoveryId: projection().recovery.id })
  expect(documents.get('p1')?.name).toBe('仍保留的稿名')
})

it('旧读取完成不能释放新变更正在持有的恢复资格', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  store.list.mockRejectedValueOnce(new Error('首次读取失败'))
  await intent('app.retry')
  const firstId = projection().recovery.id
  let releaseRead: (() => void) | undefined
  let releaseDelete: (() => void) | undefined
  let reading: Promise<unknown> | undefined
  let deleting: Promise<unknown> | undefined
  store.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseRead = () => resolve([metadata('p1', '原名')])
      }),
  )
  try {
    await act(async () => {
      reading = request('app.retry', { recoveryId: firstId })
      await waitFor(() => expect(releaseRead).toBeTypeOf('function'))
    })
    store.delete.mockRejectedValueOnce(new Error('删除失败'))
    await intent('app.delete', { id: 'p1' })
    await intent('app.retry', { recoveryId: null })
    const currentId = projection().recovery.id
    store.delete.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDelete = () => {
            documents.delete('p1')
            resolve()
          }
        }),
    )
    await act(async () => {
      deleting = request('app.retry', { recoveryId: currentId })
      await waitFor(() => expect(releaseDelete).toBeTypeOf('function'))
    })
    await act(async () => {
      releaseRead?.()
      await reading
    })
    expect(await intent('app.retry', { recoveryId: currentId })).toHaveProperty(
      'error',
    )
    expect(documents.has('p1')).toBe(true)
    await act(async () => {
      releaseDelete?.()
      await deleting
    })
    expect(documents.has('p1')).toBe(false)
    expect(projection().error).toBeNull()
  } finally {
    await act(async () => {
      releaseRead?.()
      releaseDelete?.()
      await Promise.all([reading, deleting])
    })
  }
})
