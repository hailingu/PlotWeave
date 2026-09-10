// @vitest-environment happy-dom
/**
 * App 路由壳测试（文档式双界面 + ⌘, 设置叠加，docs/ui-design.md §3.1）：
 * 首页 ↔ 编辑器状态切换、项目 CRUD 回调的 store 编排、失败路径 console.warn
 * 兜底，以及 AI 会话的恢复/保存/重试边界（issue #47 历轮评审）。子视图与
 * projectStore 以桩隔离。
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
    loadAiSession: vi.fn(),
    saveAiSession: vi.fn(),
    save: vi.fn(),
    saveQuiet: vi.fn(),
    duplicate: vi.fn(),
    delete: vi.fn(),
    onAiSessionSaved: (listener: (id: string) => void) => {
      retrySavedListeners.push(listener)
      return () => {
        const index = retrySavedListeners.indexOf(listener)
        if (index >= 0) retrySavedListeners.splice(index, 1)
      }
    },
  },
}))

/** projectStore.onAiSessionSaved 已登记的监听器（测试经此模拟后台重试成功）。 */
const retrySavedListeners: Array<(id: string) => void> = []

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
  loadAiSession: ReturnType<typeof vi.fn>
  saveAiSession: ReturnType<typeof vi.fn>
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
  retrySavedListeners.length = 0
  store.list.mockResolvedValue([{ id: 'p1', name: '雨夜' }])
  store.create.mockResolvedValue({ id: 'new-1', name: '未命名短剧' })
  store.load.mockResolvedValue(structuredClone(DOC))
  store.loadAiSession.mockResolvedValue({
    session: { schemaVersion: 1, entries: [] },
    repairError: null,
  })
})

/** 打开 p1 并等编辑器就绪。 */
async function openEditor() {
  render(<App />)
  await screen.findByTestId('home')
  await act(async () => {
    await (homeProps.current.onOpenProject as (id: string) => Promise<void>)('p1')
  })
  await screen.findByTestId('editor')
}

/** ⌘, 打开设置页再关闭，触发编辑器重挂载。 */
async function settingsRoundtrip() {
  fireEvent.keyDown(document, { key: ',', metaKey: true })
  await screen.findByTestId('settings')
  fireEvent.click(screen.getByTestId('settings'))
  await screen.findByTestId('editor')
}

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
    expect(store.loadAiSession).toHaveBeenCalledWith('p1')
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
    await openEditor()
    act(() => {
      ;(editorProps.current.onRenameProject as (name: string) => void)('雨夜·修订')
    })
    expect((editorProps.current.project as { name: string }).name).toBe('雨夜·修订')
    const savedDoc = { ...DOC, name: '雨夜·修订' }
    ;(editorProps.current.onSave as (doc: ProjectContent) => void)(savedDoc)
    expect(store.save).toHaveBeenCalledWith('p1', savedDoc)
    const aiSession = { schemaVersion: 1 as const, entries: [{ id: 1, kind: 'note' as const, text: '已保存' }] }
    await (editorProps.current.onSaveAiSession as (session: typeof aiSession) => Promise<void>)(aiSession)
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

describe('App ✦AI 会话恢复', () => {
  it('AI 会话文件损坏时仍打开画布，并将恢复错误交给编辑器提示', async () => {
    store.loadAiSession.mockRejectedValue(new Error('AI 会话文件损坏'))
    await openEditor()
    expect(editorProps.current.aiSessionError).toContain('AI 会话文件损坏')
    // 读取失败的空回退会话不可作为挂载重试的落盘内容
    expect(editorProps.current.aiSessionRetryable).toBe(false)
  })

  it('AI 会话修复回写失败时保留已恢复历史，并将错误交给编辑器提示', async () => {
    const recovered = { schemaVersion: 1 as const, entries: [{ id: 1, kind: 'note' as const, text: '已恢复' }] }
    store.loadAiSession.mockResolvedValue({ session: recovered, repairError: 'Error: 只读目录' })
    await openEditor()
    expect(editorProps.current.aiSession).toEqual(recovered)
    expect(editorProps.current.aiSessionError).toBe('Error: 只读目录')
    // 内存中是恢复出的会话：重挂载重试落盘是安全的
    expect(editorProps.current.aiSessionRetryable).toBe(true)
  })

  it('会话只存在于恢复副本时如实告知来源并保持可重试', async () => {
    const recovered = { schemaVersion: 1 as const, entries: [{ id: 1, kind: 'note' as const, text: '恢复副本' }] }
    store.loadAiSession.mockResolvedValue({
      session: recovered,
      repairError: 'Error: 磁盘已满',
      recovered: true,
    })
    await openEditor()
    expect(editorProps.current.aiSession).toEqual(recovered)
    expect(editorProps.current.aiSessionError).toContain('恢复副本')
    expect(editorProps.current.aiSessionError).toContain('磁盘已满')
    expect(editorProps.current.aiSessionRetryable).toBe(true)
  })

  it('恢复副本不可读时保留权威历史、如实告知并禁止挂载重试落盘', async () => {
    const main = { schemaVersion: 1 as const, entries: [{ id: 1, kind: 'note' as const, text: '权威历史' }] }
    store.loadAiSession.mockResolvedValue({
      session: main,
      repairError: 'AI 会话恢复副本读取失败，已暂缓保存以免覆盖更新的历史：Error: 权限拒绝',
      recovered: false,
      recoveryUnreadable: true,
    })
    await openEditor()
    expect(editorProps.current.aiSession).toEqual(main)
    expect(editorProps.current.aiSessionError).toContain('恢复副本读取失败')
    // 新旧无法确定：写入边界的顺序守卫会拒绝覆盖，自动重试只会反复报错
    expect(editorProps.current.aiSessionRetryable).toBe(false)
  })

  it('权威文件不可读时展示恢复副本、如实告知并禁止挂载重试落盘', async () => {
    const recovered = { schemaVersion: 1 as const, entries: [{ id: 1, kind: 'note' as const, text: '恢复副本' }] }
    store.loadAiSession.mockResolvedValue({
      session: recovered,
      repairError: 'Error: AI 会话文件不可读，无法确定新旧，已拒绝覆盖',
      recovered: true,
      recoveryUnreadable: false,
      authoritativeUnreadable: true,
    })
    await openEditor()
    expect(editorProps.current.aiSession).toEqual(recovered)
    expect(editorProps.current.aiSessionError).toContain('权威会话文件不可读')
    // 权威序号未知：不得自动重试提升覆盖
    expect(editorProps.current.aiSessionRetryable).toBe(false)
  })
})

describe('App ✦AI 会话保存', () => {
  it('修复回写失败后再次保存成功：项目级错误清除，重挂载不再报保存失败', async () => {
    const recovered = { schemaVersion: 1 as const, entries: [{ id: 1, kind: 'note' as const, text: '已恢复' }] }
    store.loadAiSession.mockResolvedValue({ session: recovered, repairError: 'Error: 只读目录' })
    store.saveAiSession.mockResolvedValue(undefined)
    await openEditor()
    expect(editorProps.current.aiSessionError).toBe('Error: 只读目录')
    const session = {
      schemaVersion: 1 as const,
      entries: [...recovered.entries, { id: 2, kind: 'note' as const, text: '新历史' }],
    }
    await (editorProps.current.onSaveAiSession as (value: typeof session) => Promise<void>)(session)
    await settingsRoundtrip()
    expect(editorProps.current.aiSession).toEqual(session)
    expect(editorProps.current.aiSessionError).toBeNull()
  })

  it('从设置返回时保留本次打开后新增的 AI 会话历史', async () => {
    await openEditor()
    const session = { schemaVersion: 1 as const, entries: [{ id: 1, kind: 'note' as const, text: '新的历史' }] }
    await (editorProps.current.onSaveAiSession as (value: typeof session) => Promise<void>)(session)
    await settingsRoundtrip()
    expect(editorProps.current.aiSession).toEqual(session)
  })

  it('读取失败后用户实际变更会话：内存成为权威内容，重试标记恢复为 true', async () => {
    store.loadAiSession.mockRejectedValue(new Error('AI 会话文件损坏'))
    store.saveAiSession.mockRejectedValueOnce(new Error('磁盘已满'))
    await openEditor()
    expect(editorProps.current.aiSessionRetryable).toBe(false)
    const changed = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '用户的新消息' }],
    }
    await act(async () => {
      await expect(
        (editorProps.current.onSaveAiSession as (value: typeof changed) => Promise<void>)(changed),
      ).rejects.toThrow('磁盘已满')
    })
    expect(editorProps.current.aiSession).toEqual(changed)
    // 已变更的会话是用户内容而非空回退：重挂载重试落盘是安全的
    expect(editorProps.current.aiSessionRetryable).toBe(true)
  })
})

describe('App ✦AI 会话保存失败', () => {
  it('会话保存失败时拒绝上浮，错误写入项目级：重挂载不丢警告', async () => {
    store.saveAiSession.mockRejectedValueOnce(new Error('磁盘已满'))
    await openEditor()
    const session = { schemaVersion: 1 as const, entries: [{ id: 1, kind: 'note' as const, text: '未落盘' }] }
    await act(async () => {
      await expect(
        (editorProps.current.onSaveAiSession as (value: typeof session) => Promise<void>)(session),
      ).rejects.toThrow('磁盘已满')
    })
    expect(editorProps.current.aiSession).toEqual(session)
    expect(editorProps.current.aiSessionError).toContain('磁盘已满')
    await settingsRoundtrip()
    expect(editorProps.current.aiSessionError).toContain('磁盘已满')
  })

  it('保存失败后回首页再重开：未落盘会话保留并标记可重试', async () => {
    await openEditor()
    const changed = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '未落盘' }],
    }
    store.saveAiSession.mockRejectedValueOnce(new Error('磁盘已满'))
    await act(async () => {
      await expect(
        (editorProps.current.onSaveAiSession as (value: typeof changed) => Promise<void>)(changed),
      ).rejects.toThrow('磁盘已满')
    })
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    expect(await screen.findByTestId('home')).toBeTruthy()
    // 重开同一项目：磁盘上是旧会话，但内存保留的未落盘会话胜出并标记可重试
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)('p1')
    })
    await screen.findByTestId('editor')
    expect(editorProps.current.aiSession).toEqual(changed)
    expect(editorProps.current.aiSessionError).toContain('磁盘已满')
    expect(editorProps.current.aiSessionRetryable).toBe(true)
  })
})

describe('App ✦AI 会话重试成功通知', () => {
  it('新旧未知期间的保留会话：重开时重新读取磁盘（确立定序）后再展示重试', async () => {
    // 变更保存被门禁拒绝（模拟新旧未知）→ 会话进保留区
    store.saveAiSession.mockRejectedValueOnce(new Error('AI 会话新旧未知，已暂缓保存'))
    await openEditor()
    const changed = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '编辑' }],
    }
    await act(async () => {
      await expect(
        (editorProps.current.onSaveAiSession as (value: typeof changed) => Promise<void>)(changed),
      ).rejects.toThrow('暂缓')
    })
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    expect(await screen.findByTestId('home')).toBeTruthy()

    // 重开：保留会话胜出展示，但必须重新读盘刷新定序——否则门禁永不解除，
    // 保留会话的重试永远被暂缓（死锁）
    store.loadAiSession.mockClear()
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)('p1')
    })
    await screen.findByTestId('editor')
    expect(store.loadAiSession).toHaveBeenCalledTimes(1)
    expect(editorProps.current.aiSession).toEqual(changed)
    expect(editorProps.current.aiSessionRetryable).toBe(true)
  })

  it('后台重试补写成功：清除项目级错误与保留快照，重开不再以内存会话胜出', async () => {
    store.saveAiSession.mockRejectedValueOnce(new Error('磁盘已满'))
    await openEditor()
    const changed = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '未落盘' }],
    }
    await act(async () => {
      await expect(
        (editorProps.current.onSaveAiSession as (value: typeof changed) => Promise<void>)(changed),
      ).rejects.toThrow('磁盘已满')
    })
    expect(editorProps.current.aiSessionError).toContain('磁盘已满')

    await act(async () => {
      retrySavedListeners.forEach((notify) => notify('p1'))
    })
    expect(editorProps.current.aiSessionError).toBeNull()

    // 保留快照已清：回首页重开走磁盘载入，不再以内存保留会话胜出
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    expect(await screen.findByTestId('home')).toBeTruthy()
    store.loadAiSession.mockClear()
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)('p1')
    })
    await screen.findByTestId('editor')
    expect(store.loadAiSession).toHaveBeenCalledTimes(1)
  })

  it('通知只清除对应项目：别的项目错误不受影响', async () => {
    await openEditor()
    // 经项目级状态注入另一项目的错误（onSaveAiSession 只作用于打开项目）
    const changed = { schemaVersion: 1 as const, entries: [] }
    // 打开项目的错误由保存失败产生
    store.saveAiSession.mockRejectedValueOnce(new Error('磁盘已满'))
    await act(async () => {
      await expect(
        (editorProps.current.onSaveAiSession as (value: typeof changed) => Promise<void>)(changed),
      ).rejects.toThrow('磁盘已满')
    })
    await act(async () => {
      retrySavedListeners.forEach((notify) => notify('other-project'))
    })
    expect(editorProps.current.aiSessionError).toContain('磁盘已满')
  })
})

describe('App ✦AI 会话保存失败（在途）', () => {
  it('保存在途时重开项目：保留区在加载屏障之后读取，拒绝晚到仍命中', async () => {
    await openEditor()
    let rejectSave!: (err: Error) => void
    store.saveAiSession.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectSave = reject }),
    )
    const changed = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '在途未落盘' }],
    }
    await act(async () => {
      ;(editorProps.current.onSaveAiSession as (value: typeof changed) => Promise<void>)(changed).catch(
        () => undefined,
      )
    })
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    expect(await screen.findByTestId('home')).toBeTruthy()

    // 重开：load 挂起期间保存拒绝落定（保留区在屏障内被写入）
    let releaseLoad!: (doc: ProjectContent) => void
    store.load.mockImplementation(
      () => new Promise((resolve) => { releaseLoad = resolve }),
    )
    await act(async () => {
      ;(homeProps.current.onOpenProject as (id: string) => Promise<void>)('p1')
      rejectSave(new Error('磁盘已满'))
    })
    await act(async () => {
      releaseLoad(structuredClone(DOC))
    })

    await screen.findByTestId('editor')
    expect(editorProps.current.aiSession).toEqual(changed)
    expect(editorProps.current.aiSessionError).toContain('磁盘已满')
    expect(editorProps.current.aiSessionRetryable).toBe(true)
  })
})
