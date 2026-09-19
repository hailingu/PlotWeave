// @vitest-environment happy-dom
/** PR #222：真实门面与诊断组件的集成回归，仅模拟 IPC 响应；验证所有
 * 诊断入口和关闭/失败/迟到响应均不能让 warning-only 冲突获得清理指引。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { libraryStore } from '../../library/libraryStore'

const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const conflict =
  '资产 la-conflict 删除事务冲突（原路径已被后来文件占用），标记为不可用'
const routine = '媒体已隔离待清理：assets/la-deleted.png'

beforeEach(() => {
  vi.resetModules()
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: { invoke },
  })
  invoke.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  vi.restoreAllMocks()
})

/** 模拟各命令共同的恢复结果，保留列表、资产、组响应各自的载荷形状。 */
function response(command: string, warnings: string[] = [conflict]) {
  const diagnostics = { warnings, cleanupPending: [routine] }
  const asset = {
    id: 'la-conflict',
    name: '原媒体',
    kind: 'reference',
    mime: 'image/png',
    relPath: 'assets/la-conflict.png',
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    conflicted: warnings.length > 0,
  }
  if (command === 'list_library_assets') {
    return {
      assets: { byId: { [asset.id]: asset } },
      groups: { byId: {} },
      ...diagnostics,
    }
  }
  if (command === 'upsert_library_group') {
    return { id: 'g-1', name: '角色', kind: 'character', ...diagnostics }
  }
  return { ...asset, ...diagnostics }
}

/** 穿过公开门面的全部七个诊断入口，避免只验证一个组件手工发布路径。 */
const operations: [string, (store: typeof libraryStore) => Promise<unknown>][] =
  [
    ['list', (store) => store.list()],
    ['listGroups', (store) => store.listGroups()],
    ['put', (store) => store.put(new File(['x'], 'a.png'), 'reference')],
    ['updateMeta', (store) => store.updateMeta('la-1', { name: '新名' })],
    ['remove', (store) => store.remove('la-1')],
    [
      'upsertGroup',
      (store) =>
        store.upsertGroup({ id: 'g-1', name: '角色', kind: 'character' }),
    ],
    ['deleteGroup', (store) => store.deleteGroup('g-1')],
  ]

it.each(operations)(
  '%s 的 warning-only 冲突暂停清理且保留明细',
  async (_, run) => {
    const { libraryStore } = await import('../../library/libraryStore')
    const { LibraryWarnings } = await import('./LibraryWarnings')
    invoke.mockImplementation(async (command) => response(String(command)))
    render(<LibraryWarnings />)
    await act(async () => {
      await run(libraryStore)
    })
    expect(screen.getByText(conflict)).toBeTruthy()
    expect(screen.getByText(routine)).toBeTruthy()
    expect(screen.getByRole('note', { name: '隔离区清理暂停' })).toBeTruthy()
    expect(screen.queryByRole('note', { name: '隔离区清理指引' })).toBeNull()
  },
)

it('关闭和重新挂载后，失败及迟到的干净响应不能解除会话保护', async () => {
  const { libraryStore } = await import('../../library/libraryStore')
  const { LibraryWarnings } = await import('./LibraryWarnings')
  let finishEarlier!: (value: unknown) => void
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishEarlier = resolve
      }),
  )
  const earlier = libraryStore.listGroups()
  invoke.mockResolvedValueOnce(response('list_library_assets'))
  const view = render(<LibraryWarnings />)
  await act(async () => {
    await libraryStore.list()
  })
  fireEvent.click(screen.getByRole('button', { name: '关闭图库提示' }))
  view.unmount()
  invoke.mockRejectedValueOnce(new Error('IPC 失败'))
  await expect(libraryStore.list()).rejects.toThrow('IPC 失败')
  const clean = response('list_library_assets', [])
  clean.cleanupPending = [routine, '媒体已隔离待清理：assets/la-new.png']
  await act(async () => {
    finishEarlier(clean)
    await earlier
  })
  render(<LibraryWarnings />)
  expect(screen.queryByText(conflict)).toBeNull()
  expect(screen.getByRole('note', { name: '隔离区清理暂停' })).toBeTruthy()
  expect(screen.queryByRole('note', { name: '隔离区清理指引' })).toBeNull()
})

it('新会话重新读取干净状态后，常规待清理项仍有清理指引', async () => {
  const { libraryStore } = await import('../../library/libraryStore')
  const { LibraryWarnings } = await import('./LibraryWarnings')
  invoke.mockResolvedValueOnce(response('list_library_assets', []))
  render(<LibraryWarnings />)
  await act(async () => {
    await libraryStore.list()
  })
  expect(screen.getByRole('note', { name: '隔离区清理指引' })).toBeTruthy()
  expect(screen.queryByRole('note', { name: '隔离区清理暂停' })).toBeNull()
})
