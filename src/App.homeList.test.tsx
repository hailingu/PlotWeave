// @vitest-environment happy-dom
/**
 * App 首页列表域测试（issue #525 自 App.test.tsx 拆分）：保存落定后的
 * 摘要自动刷新（issue #101，编辑器打开期间不刷新防整树重渲染）、并发
 * 刷新的代际收敛，以及列表读取失败的错误态处置（issue #133）。
 * 子视图与 projectStore 桩经 appShellTestScaffolding 委托。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { App } from './App'
import type { ProjectContent } from './projectStore'
import {
  DOC,
  editorProps,
  homeProps,
  openEditor,
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

afterEach(cleanup)

beforeEach(() => resetAppShellFixture())

describe('App ✦返回首页摘要与保存落定（issue #101）', () => {
  it('保存在途时返回首页：保存落定通知后再刷新，卡片跟随新摘要', async () => {
    await openEditor(App)
    let releaseSave: (() => void) | null = null
    // Once 变体：挂起实现不得泄漏到后续用例（clearAllMocks 不清实现，
    // 普通实现会让其后所有 await store.save 的用例永久挂起）
    store.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve
        }),
    )
    act(() => {
      ;(editorProps.current.onSave as (doc: ProjectContent) => void)({
        ...DOC,
        name: '新名称',
      })
    })
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    expect(await screen.findByTestId('home')).toBeTruthy()
    // 返回首页的列表读取先于保存落定：此刻（第 2 次 list）读到旧摘要
    expect(store.list).toHaveBeenCalledTimes(2)
    // 保存落定成功（存储层通知首页）→ 自动再刷新，读到新名称
    store.list.mockResolvedValue([{ id: 'p1', name: '新名称' }])
    await act(async () => {
      releaseSave?.()
      savedListeners.forEach((notify) => notify('p1'))
    })
    expect(store.list).toHaveBeenCalledTimes(3)
    expect(
      (homeProps.current.projects as Array<{ name: string }>)[0]?.name,
    ).toBe('新名称')
  })

  it('编辑器打开期间保存落定：不触发首页列表刷新（首页不可见，防整树重渲染）', async () => {
    await openEditor(App)
    expect(store.list).toHaveBeenCalledTimes(1)
    await act(async () => {
      savedListeners.forEach((notify) => notify('p1'))
    })
    expect(store.list).toHaveBeenCalledTimes(1)
  })

  it('并发刷新：先发起的慢响应不得覆盖较新刷新的结果', async () => {
    render(<App />)
    expect(await screen.findByText('共1项')).toBeTruthy()
    let releaseSlow!: (value: Array<{ id: string; name: string }>) => void
    store.list
      .mockImplementationOnce(
        () =>
          new Promise<Array<{ id: string; name: string }>>((resolve) => {
            releaseSlow = resolve
          }),
      )
      .mockResolvedValueOnce([{ id: 'p1', name: '新名称' }])
    await act(async () => {
      savedListeners.forEach((notify) => notify('p1'))
    })
    await act(async () => {
      savedListeners.forEach((notify) => notify('p1'))
    })
    // 慢刷新（旧摘要）最后落定：不得覆盖较新发起且已完成的新摘要
    await act(async () => {
      releaseSlow([{ id: 'p1', name: '旧名称' }])
    })
    expect(
      (homeProps.current.projects as Array<{ name: string }>)[0]?.name,
    ).toBe('新名称')
  })
})

describe('App ✦首页列表读取失败处置（issue #133）', () => {
  it('已有列表刷新失败：保留已知列表并置错误态；重试成功清除', async () => {
    render(<App />)
    await screen.findByText('共1项')
    store.list.mockRejectedValueOnce(new Error('目录不可读'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await act(async () => {
      await (homeProps.current.onRetryLoad as () => Promise<void>)()
    })
    expect(await screen.findByText('共1项')).toBeTruthy()
    expect(homeProps.current.loadError).toMatch(/目录不可读/)
    warn.mockRestore()

    await act(async () => {
      await (homeProps.current.onRetryLoad as () => Promise<void>)()
    })
    expect(await screen.findByText('共1项')).toBeTruthy()
    expect(homeProps.current.loadError).toBeNull()
  })

  it('较旧的失败响应不得覆盖较新的成功（#133）', async () => {
    let rejectSlow!: (err: Error) => void
    store.list.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSlow = reject
        }),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<App />)
    // 首次加载挂起期间发起重试（较新）并成功
    await act(async () => {
      await (homeProps.current.onRetryLoad as () => Promise<void>)()
    })
    expect(await screen.findByText('共1项')).toBeTruthy()
    // 迟到的首次加载失败：被代际守卫取代，不清列表、不置错误
    rejectSlow(new Error('迟到的目录错误'))
    await act(async () => {})
    expect(await screen.findByText('共1项')).toBeTruthy()
    expect(homeProps.current.loadError).toBeNull()
    warn.mockRestore()
  })
})
