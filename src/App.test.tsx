// @vitest-environment happy-dom
/**
 * App 路由壳测试（文档式双界面 + ⌘, 设置叠加，docs/ui-design.md §3.1）：
 * 首页 ↔ 编辑器状态切换、编辑器回调编排与 ⌘, 快捷键/原生壳导航。
 * issue #525 按功能域拆分后本文件只保留路由与设置域；子视图与
 * projectStore 桩经 appShellTestScaffolding 委托共享。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { App } from './App'
import type { ProjectContent } from './projectStore'
import {
  DOC,
  afterAppShellTest,
  consoleWarn,
  expectConsoleWarn,
  homeProps,
  editorProps,
  openEditor,
  resetAppShellFixture,
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

describe('App（双界面路由壳）', () => {
  it('启动加载项目列表 → 首页；列表失败进入错误态而非空列表（#133）', async () => {
    render(<App />)
    expect(await screen.findByText('共1项')).toBeTruthy()
    expect(store.list).toHaveBeenCalledTimes(1)
    cleanup()
    store.list.mockRejectedValue(new Error('io'))
    expectConsoleWarn()
    render(<App />)
    expect(await screen.findByText('共0项')).toBeTruthy()
    // 读取失败 ≠ 空列表：错误态就位（HomePage 侧不渲染首次使用引导）
    await waitFor(() =>
      expect(typeof homeProps.current.loadError).toBe('string'),
    )
    expect(homeProps.current.loadError).toMatch(/io/)
    expect(typeof homeProps.current.onRetryLoad).toBe('function')
    expect(consoleWarn.spy).toHaveBeenCalled()
  })

  it('打开项目：load 成功进编辑器；失败停留首页', async () => {
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'p1',
      )
    })
    expect(store.load).toHaveBeenCalledWith('p1')
    expect(store.loadAiSession).toHaveBeenCalledWith('p1')
    expect(await screen.findByTestId('editor')).toBeTruthy()
    cleanup()
    store.load.mockRejectedValue(new Error('gone'))
    expectConsoleWarn()
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'ghost',
      )
    })
    expect(screen.queryByTestId('editor')).toBeNull()
  })

  it('新建项目：create 后按落盘文档载入会话（保留 createdAt 溯源），并刷新列表', async () => {
    const createdDoc: ProjectContent = {
      ...DOC,
      name: '未命名短剧',
      createdAt: '2026-08-31T00:00:00.000Z',
    }
    store.load.mockResolvedValue(structuredClone(createdDoc))
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      ;(homeProps.current.onCreateProject as () => void)()
    })
    expect(store.create).toHaveBeenCalledWith('未命名短剧')
    // create 只回摘要：须 load 落盘文档进会话，否则首次保存把保存时刻误盖为创建时间
    expect(store.load).toHaveBeenCalledWith('new-1')
    expect(await screen.findByTestId('editor')).toBeTruthy()
    expect(
      (editorProps.current.project as { createdAt?: string }).createdAt,
    ).toBe('2026-08-31T00:00:00.000Z')
    expect(store.list).toHaveBeenCalledTimes(3)
  })
})

describe('App（导航与编辑器回调）', () => {
  it('编辑器回调：改名更新打开态文档名；保存委托 save（失败上浮给编辑器重试/横幅）；返回首页刷新', async () => {
    await openEditor(App)
    act(() => {
      ;(editorProps.current.onRenameProject as (name: string) => void)(
        '雨夜·修订',
      )
    })
    expect((editorProps.current.project as { name: string }).name).toBe(
      '雨夜·修订',
    )
    const savedDoc = { ...DOC, name: '雨夜·修订' }
    ;(editorProps.current.onSave as (doc: ProjectContent) => void)(savedDoc)
    expect(store.save).toHaveBeenCalledWith('p1', savedDoc)
    const aiSession = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '已保存' }],
    }
    await (
      editorProps.current.onSaveAiSession as (
        session: typeof aiSession,
      ) => Promise<void>
    )(aiSession)
    expect(store.saveAiSession).toHaveBeenCalledWith('p1', aiSession)
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    expect(await screen.findByTestId('home')).toBeTruthy()
    expect(store.list).toHaveBeenCalledTimes(2)
  })

  it('首页卡片菜单：重命名读档改名后保存；复制/删除委托 store 并刷新', async () => {
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      await (
        homeProps.current.onRenameProject as (
          id: string,
          name: string,
        ) => Promise<void>
      )('p1', '新名')
    })
    expect(store.save).toHaveBeenCalledWith('p1', { ...DOC, name: '新名' })
    await act(async () => {
      await (
        homeProps.current.onDuplicateProject as (id: string) => Promise<void>
      )('p1')
    })
    expect(store.duplicate).toHaveBeenCalledWith('p1')
    await act(async () => {
      await (
        homeProps.current.onDeleteProject as (id: string) => Promise<void>
      )('p1')
    })
    expect(store.delete).toHaveBeenCalledWith('p1')
    expect(store.list.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('⌘, 打开设置叠加；关闭回原界面；普通逗号键不触发', async () => {
    render(<App />)
    await screen.findByTestId('home')
    fireEvent.keyDown(document, { key: ',' })
    expect(screen.queryByTestId('settings')).toBeNull()
    fireEvent.keyDown(document, { key: ',', metaKey: true })
    expect(await screen.findByTestId('settings')).toBeTruthy()
    fireEvent.click(screen.getByTestId('settings'))
    expect(await screen.findByTestId('home')).toBeTruthy()
  })
})

describe('App ✦⌘, 应用级模态挂起（issue #263 评审）', () => {
  it('aria-modal 弹窗打开时 ⌘, 挂起，弹窗关闭后恢复', async () => {
    await openEditor(App)
    // 夹具：编辑器内打开的 aria-modal 弹窗（真实渲染与 aria-modal 标注由
    // ExportDialog 组件测试覆盖，此处覆盖 App 级监听的存在性挂起链路）
    const modal = document.createElement('dialog')
    modal.open = true
    modal.setAttribute('aria-modal', 'true')
    screen.getByTestId('editor').appendChild(modal)
    fireEvent.keyDown(document, { key: ',', metaKey: true })
    await act(async () => {})
    expect(screen.queryByTestId('settings')).toBeNull()
    expect(screen.getByTestId('editor')).toBeTruthy()
    modal.remove()
    fireEvent.keyDown(document, { key: ',', metaKey: true })
    expect(await screen.findByTestId('settings')).toBeTruthy()
  })
})

/** Native shell consumes the same App coordinator through read-only projections. */
it('原生项目动作进入共享协调层，设置往返保留同一编辑器', async () => {
  const nativeWindow = window as Window & {
    __pwNativeHost?: unknown
    __pwNativeIntent?: (request: unknown) => Promise<unknown>
    webkit?: unknown
  }
  const postMessage = vi.fn()
  nativeWindow.__pwNativeHost = {
    kind: 'swift',
    protocolVersion: 1,
    sessionId: 'app-page',
  }
  nativeWindow.webkit = { messageHandlers: { canvasHost: { postMessage } } }
  let requestNo = 0
  const intent = (command: string, args: unknown = {}) =>
    nativeWindow.__pwNativeIntent?.({
      protocolVersion: 1,
      sessionId: 'app-page',
      requestId: String(++requestNo),
      command,
      args,
    })
  try {
    render(<App />)
    await waitFor(() =>
      expect(nativeWindow.__pwNativeIntent).toBeTypeOf('function'),
    )
    await act(async () => {
      await intent('app.open', { id: 'p1' })
    })
    const editor = await screen.findByTestId('editor')
    await act(async () => {
      await intent('app.settings')
    })
    await screen.findByTestId('settings')
    expect(screen.getByTestId('editor')).toBe(editor)
    fireEvent.click(screen.getByTestId('settings'))
    await waitFor(() => expect(screen.queryByTestId('settings')).toBeNull())
    expect(screen.getByTestId('editor')).toBe(editor)
    await act(async () => {
      await intent('app.home')
    })
    await waitFor(() => expect(screen.queryByTestId('editor')).toBeNull())
    const snapshots = postMessage.mock.calls
      .map(([value]) => value.projection?.app)
      .filter(Boolean)
    expect(
      snapshots.some(
        (state) => state.route === 'editor' && state.project.id === 'p1',
      ),
    ).toBe(true)
    expect(snapshots[snapshots.length - 1].route).toBe('home')
    expect(snapshots[snapshots.length - 1].projects).toEqual([
      { id: 'p1', name: '雨夜' },
    ])
  } finally {
    cleanup()
    delete nativeWindow.__pwNativeHost
    delete nativeWindow.webkit
  }
})
