// @vitest-environment happy-dom
/**
 * App 重命名后台恢复域测试（issue #525 自 App.test.tsx 拆分）：重命名
 * 保存失败后经共享保存链的后台重试恢复——当前文档重存成功才清错、
 * 同名不同文档不能清错、旧恢复不覆盖新失败、旧读取不篡改恢复身份
 * （PR #199 评审）；连续重命名读取乱序时旧意图不交付保存（issue #801）。
 * 子视图与 projectStore 桩经 appShellTestScaffolding
 * 委托；notifyRetryPersisted 走真实 saveChain 模块。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { App } from './App'
import type { ProjectContent } from './projectStore'
import { notifyRetryPersisted } from './projectStore/saveChain'
import {
  DOC,
  afterAppShellTest,
  expectConsoleWarn,
  failHomeRename,
  homeProps,
  resetAppShellFixture,
  savedListeners,
  store,
} from './appShellTestScaffolding'

vi.mock('./projectStore', async () =>
  (await import('./appShellTestScaffolding')).projectStoreMockModule(),
)
vi.mock('./home/HomePage', async () =>
  (await import('./appShellTestScaffolding')).homePageMockModule(),
)
vi.mock('./editor/EditorView', async () =>
  (await import('./appShellTestScaffolding')).editorViewMockModule(),
)
vi.mock('./settings/SettingsView', async () =>
  (await import('./appShellTestScaffolding')).settingsViewMockModule(),
)

afterEach(afterAppShellTest)

beforeEach(() => resetAppShellFixture())

it('App ✦重命名后台恢复：当前文档重存成功后横幅消失、卡片刷新', async () => {
  expectConsoleWarn()
  const doc = await failHomeRename(App)
  store.list.mockResolvedValue([{ id: 'p1', name: '新名' }])
  await act(async () => {
    notifyRetryPersisted(doc)
    savedListeners.forEach((notify) => notify('p1'))
  })
  expect(homeProps.current.projects).toEqual([{ id: 'p1', name: '新名' }])
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByTestId('retry-mutation')).toBeNull()
})

it('App ✦重命名后台恢复：同名但不同文档的成功通知不能清错', async () => {
  expectConsoleWarn()
  const doc = await failHomeRename(App)
  act(() => notifyRetryPersisted(structuredClone(doc)))
  expect(screen.getByRole('alert').textContent).toMatch(/暂时只读/)
  act(() => notifyRetryPersisted(doc))
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['rename', 'delete'] as const)(
  'App ✦重命名后台恢复：旧恢复不能清除后续 %s 失败',
  async (action) => {
    expectConsoleWarn()
    const oldDoc = await failHomeRename(App)
    if (action === 'rename')
      store.save.mockRejectedValueOnce(new Error('新失败'))
    else store.delete.mockRejectedValueOnce(new Error('新失败'))
    await act(async () => {
      if (action === 'rename') {
        await (
          homeProps.current.onRenameProject as (
            id: string,
            name: string,
          ) => Promise<void>
        )('p1', '后名')
      } else {
        await (
          homeProps.current.onDeleteProject as (id: string) => Promise<void>
        )('p1')
      }
    })
    act(() => notifyRetryPersisted(oldDoc))
    expect(screen.getByRole('alert').textContent).toContain(`${action}:`)
    expect(screen.getByRole('alert').textContent).toMatch(/新失败/)
    if (action === 'rename') {
      act(() =>
        notifyRetryPersisted(store.save.mock.lastCall![1] as ProjectContent),
      )
      expect(screen.queryByRole('alert')).toBeNull()
    }
  },
)

it('App ✦重命名后台恢复：旧读取迟到不覆盖新尝试的恢复身份', async () => {
  expectConsoleWarn()
  let release!: (doc: ProjectContent) => void
  store.load.mockImplementationOnce(
    () =>
      new Promise<ProjectContent>((resolve) => {
        release = resolve
      }),
  )
  // 旧意图读档返回后被作废、不再交付保存（issue #801），仅新尝试的
  // 保存被拒绝；旧读取的迟到仍不得篡改新尝试登记的恢复文档身份
  store.save.mockRejectedValueOnce(new Error('暂时只读'))
  render(<App />)
  await screen.findByText('共1项')
  let first!: Promise<void>
  await act(async () => {
    const rename = homeProps.current.onRenameProject as (
      id: string,
      name: string,
    ) => Promise<void>
    first = rename('p1', '旧名')
    await rename('p1', '新名')
  })
  const currentDoc = store.save.mock.lastCall![1] as ProjectContent
  await act(async () => {
    release(structuredClone(DOC))
    await first
    notifyRetryPersisted(currentDoc)
  })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('App ✦重命名后台恢复：先收到恢复成功、后处理保存拒绝，错误不复活', async () => {
  expectConsoleWarn()
  store.save.mockImplementationOnce(
    async (_id: string, doc: ProjectContent) => {
      notifyRetryPersisted(doc)
      throw new Error('迟到的拒绝')
    },
  )
  render(<App />)
  await screen.findByText('共1项')
  await act(async () => {
    await (
      homeProps.current.onRenameProject as (
        id: string,
        name: string,
      ) => Promise<void>
    )('p1', '新名')
  })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('App ✦连续重命名：读取乱序时旧意图不交付保存，最终落盘为新名（issue #801）', async () => {
  let release!: (doc: ProjectContent) => void
  store.load.mockImplementationOnce(
    () =>
      new Promise<ProjectContent>((resolve) => {
        release = resolve
      }),
  )
  render(<App />)
  await screen.findByText('共1项')
  let first!: Promise<void>
  await act(async () => {
    const rename = homeProps.current.onRenameProject as (
      id: string,
      name: string,
    ) => Promise<void>
    first = rename('p1', '旧名')
    await rename('p1', '新名')
  })
  await act(async () => {
    release(structuredClone(DOC))
    await first
  })
  const savedNames = store.save.mock.calls.map(
    (call) => (call[1] as ProjectContent).name,
  )
  expect(savedNames).toEqual(['新名'])
  expect(screen.queryByRole('alert')).toBeNull()
})
