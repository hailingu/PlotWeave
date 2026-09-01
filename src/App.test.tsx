// @vitest-environment happy-dom
/**
 * App 路由壳测试（文档式双界面 + ⌘, 设置叠加，docs/ui-design.md §3.1）：
 * 首页 ↔ 编辑器状态切换、项目 CRUD 回调的 store 编排、
 * 失败路径 console.warn 兜底。子视图与 projectStore 以桩隔离。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import App from './App'
import { projectStore } from './projectStore'
import type { ProjectContent } from './projectStore'

/** 子视图最近一次的 props（回调经此触发，断言经此读参）。 */
const homeProps: { current: Record<string, unknown> } = { current: {} }
const editorProps: { current: Record<string, unknown> } = { current: {} }

vi.mock('./projectStore', () => ({
  projectStore: {
    list: vi.fn(),
    create: vi.fn(),
    load: vi.fn(),
    save: vi.fn(),
    saveQuiet: vi.fn(),
    duplicate: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('./home/HomePage', () => ({
  default: (props: Record<string, unknown>) => {
    homeProps.current = props
    return <div data-testid="home">{props.loading ? '加载中' : `共${(props.projects as unknown[]).length}项`}</div>
  },
}))

vi.mock('./editor/EditorView', () => ({
  default: (props: Record<string, unknown>) => {
    editorProps.current = props
    return <div data-testid="editor">{(props.project as { name: string }).name}</div>
  },
}))

vi.mock('./settings/SettingsView', () => ({
  default: (props: { onClose: () => void }): ReactNode => (
    <button type="button" data-testid="settings" onClick={props.onClose}>
      设置
    </button>
  ),
}))

const store = projectStore as unknown as {
  list: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  saveQuiet: ReturnType<typeof vi.fn>
  duplicate: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
}

const DOC: ProjectContent = {
  name: '雨夜',
  nodes: [],
  edges: [],
  settings: { characters: [], locations: [] },
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  store.list.mockResolvedValue([{ id: 'p1', name: '雨夜' }])
  store.create.mockResolvedValue({ id: 'new-1', name: '未命名短剧' })
  store.load.mockResolvedValue(structuredClone(DOC))
})

describe('App（双界面路由壳）', () => {
  it('启动加载项目列表 → 首页；列表失败 warn 兜底为空', async () => {
    render(<App />)
    expect(await screen.findByText('共1项')).toBeTruthy()
    expect(store.list).toHaveBeenCalledTimes(1)
    cleanup()

    store.list.mockRejectedValue(new Error('io'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<App />)
    expect(await screen.findByText('共0项')).toBeTruthy()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('打开项目：load 成功进编辑器；失败停留首页', async () => {
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)('p1')
    })
    expect(store.load).toHaveBeenCalledWith('p1')
    expect(await screen.findByTestId('editor')).toBeTruthy()
    cleanup()

    store.load.mockRejectedValue(new Error('gone'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)('ghost')
    })
    expect(screen.queryByTestId('editor')).toBeNull()
    warn.mockRestore()
  })

  it('新建项目：create 后按落盘文档载入会话（保留 createdAt 溯源），并刷新列表', async () => {
    const createdDoc: ProjectContent = { ...DOC, name: '未命名短剧', createdAt: '2026-08-31T00:00:00.000Z' }
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
    expect((editorProps.current.project as { createdAt?: string }).createdAt).toBe(
      '2026-08-31T00:00:00.000Z',
    )
    expect(store.list).toHaveBeenCalledTimes(2)
  })

  it('编辑器回调：改名更新打开态文档名；保存委托 save（失败上浮给编辑器重试/横幅）；返回首页刷新', async () => {
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)('p1')
    })
    await screen.findByTestId('editor')

    act(() => {
      ;(editorProps.current.onRenameProject as (name: string) => void)('雨夜·修订')
    })
    expect((editorProps.current.project as { name: string }).name).toBe('雨夜·修订')

    const savedDoc = { ...DOC, name: '雨夜·修订' }
    ;(editorProps.current.onSave as (doc: ProjectContent) => void)(savedDoc)
    expect(store.save).toHaveBeenCalledWith('p1', savedDoc)

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
      await (homeProps.current.onRenameProject as (id: string, name: string) => Promise<void>)('p1', '新名')
    })
    expect(store.saveQuiet).toHaveBeenCalledWith('p1', { ...DOC, name: '新名' })

    await act(async () => {
      await (homeProps.current.onDuplicateProject as (id: string) => Promise<void>)('p1')
    })
    expect(store.duplicate).toHaveBeenCalledWith('p1')

    await act(async () => {
      await (homeProps.current.onDeleteProject as (id: string) => Promise<void>)('p1')
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
