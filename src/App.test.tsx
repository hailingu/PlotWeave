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
/** EditorView mock 的累计渲染次数（issue #61：保存不得重渲染编辑器子树）。 */
const editorRenders = { count: 0 }

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
    onProjectSaved: (listener: (id: string) => void) => {
      savedListeners.push(listener)
      return () => {
        const index = savedListeners.indexOf(listener)
        if (index >= 0) savedListeners.splice(index, 1)
      }
    },
    onAiSessionSaveFailed: (
      listener: (
        id: string,
        event: { session: unknown; error: string },
      ) => void,
    ) => {
      replayFailedListeners.push(listener)
      return () => {
        const index = replayFailedListeners.indexOf(listener)
        if (index >= 0) replayFailedListeners.splice(index, 1)
      }
    },
  },
}))

/** projectStore.onAiSessionSaved 已登记的监听器（测试经此模拟退出重试成功）。 */
const retrySavedListeners: Array<(id: string) => void> = []
/** projectStore.onProjectSaved 已登记的监听器（测试经此模拟画布保存落定，issue #101）。 */
const savedListeners: Array<(id: string) => void> = []
/** projectStore.onAiSessionSaveFailed 已登记的监听器（测试经此模拟回吐重排失败）。 */
const replayFailedListeners: Array<
  (id: string, event: { session: unknown; error: string }) => void
> = []

vi.mock('./home/HomePage', () => ({
  default: (props: Record<string, unknown>) => {
    homeProps.current = props
    const openError = props.openError as { detail: string } | null | undefined
    return (
      <div data-testid="home">
        {props.loading
          ? '加载中'
          : `共${(props.projects as unknown[]).length}项`}
        {openError ? <div role="alert">{openError.detail}</div> : null}
      </div>
    )
  },
}))

/** 编辑器挂起门（PR #110 评审并发用例）：非空时编辑器子树抛出该 Promise
 * 令过渡停在 chunk 加载态、首页保持可交互——模拟真实 lazy chunk 的排队
 * 导航提交窗口。仅并发用例设置，beforeEach 复位。 */
let editorSuspendGate: Promise<void> | null = null

vi.mock('./editor/EditorView', () => ({
  default: (props: Record<string, unknown>) => {
    if (editorSuspendGate) throw editorSuspendGate
    editorProps.current = props
    editorRenders.count += 1
    return (
      <div data-testid="editor">{(props.project as { name: string }).name}</div>
    )
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
  editorRenders.count = 0
  editorSuspendGate = null
  retrySavedListeners.length = 0
  savedListeners.length = 0
  replayFailedListeners.length = 0
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
    await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
      'p1',
    )
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
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'p1',
      )
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
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'ghost',
      )
    })
    expect(screen.queryByTestId('editor')).toBeNull()
    warn.mockRestore()
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
    expect(store.list).toHaveBeenCalledTimes(2)
  })
})

describe('App（导航与编辑器回调）', () => {
  it('编辑器回调：改名更新打开态文档名；保存委托 save（失败上浮给编辑器重试/横幅）；返回首页刷新', async () => {
    await openEditor()
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
    expect(store.saveQuiet).toHaveBeenCalledWith('p1', { ...DOC, name: '新名' })
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

describe('App ✦返回首页摘要与保存落定（issue #101）', () => {
  it('保存在途时返回首页：保存落定通知后再刷新，卡片跟随新摘要', async () => {
    await openEditor()
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
    await openEditor()
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

describe('App ✦设置往返保留最新画布文档（issue #118）', () => {
  /** 打开项目并保存一份全字段变更文档，返回该文档供种子断言。 */
  async function saveRevisedDoc() {
    await openEditor()
    const revised: ProjectContent = {
      ...DOC,
      name: '雨夜·二稿',
      nodes: [
        {
          id: 'n1',
          type: 'scene',
          position: { x: 0, y: 0 },
          data: {
            name: '开场',
            sceneNo: 1,
            interior: false,
            time: '夜',
            synopsis: '雨夜出租车',
            characterIds: [],
          },
        },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n1' }],
      settings: { characters: [], locations: [] },
      episodeTitles: { 1: '第一集' },
      viewport: { x: 12, y: 34, zoom: 1.25 },
      aiRevision: 3,
      assets: {
        byId: {
          a1: {
            id: 'a1',
            relPath: 'projects/p1/assets/a1.wav',
            mime: 'audio/wav',
            source: 'upload',
            createdAt: '2026-09-14T00:00:00.000Z',
          },
        },
      },
    }
    await act(async () => {
      await (
        editorProps.current.onSave as (doc: ProjectContent) => Promise<void>
      )(structuredClone(revised))
    })
    return revised
  }

  it('保存落定后设置往返：重挂载种子解析保存路径的最新文档（全字段一致）', async () => {
    const revised = await saveRevisedDoc()
    await settingsRoundtrip()
    expect(editorProps.current.project).toEqual({ id: 'p1', ...revised })
  })

  it('保存在途时设置往返：重挂载种子仍为最新文档，不回退打开快照', async () => {
    await openEditor()
    let releaseSave: (() => void) | null = null
    // Once 变体：挂起实现不得泄漏到后续用例（clearAllMocks 不清实现）
    store.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve
        }),
    )
    const revised = { ...DOC, name: '雨夜·在途' }
    await act(async () => {
      ;(editorProps.current.onSave as (doc: ProjectContent) => Promise<void>)(
        revised,
      ).catch(() => undefined)
    })
    await settingsRoundtrip()
    expect(editorProps.current.project).toEqual({ id: 'p1', ...revised })
    await act(async () => {
      releaseSave?.()
    })
  })

  it('保存失败后设置往返：重挂载种子为内存最新文档（失败不得回退打开快照）', async () => {
    await openEditor()
    store.save.mockRejectedValueOnce(new Error('磁盘已满'))
    const revised = { ...DOC, name: '雨夜·未落盘' }
    await act(async () => {
      await expect(
        (editorProps.current.onSave as (doc: ProjectContent) => Promise<void>)(
          revised,
        ),
      ).rejects.toThrow('磁盘已满')
    })
    await settingsRoundtrip()
    expect(editorProps.current.project).toEqual({ id: 'p1', ...revised })
  })

  it('返回首页清除带外文档：重开项目以磁盘载入为准，旧引用不得胜出', async () => {
    const revised = await saveRevisedDoc()
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    await screen.findByTestId('home')
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'p1',
      )
    })
    await screen.findByTestId('editor')
    // load 桩固定返回打开快照：带外引用已清除，磁盘载入结果胜出
    expect(editorProps.current.project).toEqual({
      id: 'p1',
      ...structuredClone(DOC),
    })
    expect(editorProps.current.project).not.toEqual({ id: 'p1', ...revised })
  })

  it('首次保存后改名：重挂载种子同步改名，旧名称不得回退（issue #118 评审）', async () => {
    await openEditor()
    await act(async () => {
      await (
        editorProps.current.onSave as (doc: ProjectContent) => Promise<void>
      )(structuredClone(DOC))
    })
    act(() => {
      ;(editorProps.current.onRenameProject as (name: string) => void)(
        '雨夜·修订',
      )
    })
    expect((editorProps.current.project as { name: string }).name).toBe(
      '雨夜·修订',
    )
  })

  it('返回首页后卸载冲刷复活的引用不得在重开时胜出（issue #118 评审）', async () => {
    await openEditor()
    // 真实编辑器卸载冲刷经此闭包在返回首页后把最新文档交回 onSave
    const staleOnSave = editorProps.current.onSave as (
      doc: ProjectContent,
    ) => Promise<void>
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    await screen.findByTestId('home')
    await act(async () => {
      await staleOnSave({ ...structuredClone(DOC), name: '冲刷交付' })
    })
    // 首页改名后重开：load 桩返回改名后的文档，复活的引用不得胜出
    store.load.mockResolvedValue({ ...structuredClone(DOC), name: '首页改名' })
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'p1',
      )
    })
    await screen.findByTestId('editor')
    expect((editorProps.current.project as { name: string }).name).toBe(
      '首页改名',
    )
  })

  it('画布保存路径写带外引用不触发渲染：编辑器子树零次多余提交', async () => {
    await openEditor()
    const rendersBefore = editorRenders.count
    await act(async () => {
      await (
        editorProps.current.onSave as (doc: ProjectContent) => Promise<void>
      )(structuredClone(DOC))
    })
    expect(editorRenders.count).toBe(rendersBefore)
  })
})

/** 打开项目并等待结果落定（openError 已写入或编辑器已挂载）。 */
async function attemptOpen(id: string) {
  await act(async () => {
    await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(id)
  })
}

describe('App ✦首页打开失败反馈（issue #98）', () => {
  it('打开失败：错误上浮为 openError 传给首页显示警示，停留首页', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.load.mockRejectedValue(
      new Error('文档版本过新（schemaVersion 2），请升级应用'),
    )
    render(<App />)
    await screen.findByTestId('home')
    await attemptOpen('p1')
    warn.mockRestore()
    expect(screen.queryByTestId('editor')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('请升级应用')
    const openError = homeProps.current.openError as {
      id: string
      detail: string
    }
    expect(openError.id).toBe('p1')
    expect(openError.detail).toBe('文档版本过新（schemaVersion 2），请升级应用')
  })

  it('打开失败（IPC 字符串拒绝）：字符串原样作为原因', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.load.mockRejectedValue('项目文件不可读')
    render(<App />)
    await screen.findByTestId('home')
    await attemptOpen('p1')
    warn.mockRestore()
    expect((homeProps.current.openError as { detail: string }).detail).toBe(
      '项目文件不可读',
    )
  })
})

describe('App ✦打开失败后的错误清理时机（issue #98）', () => {
  it('失败后重试同一项目成功：横幅清除，回首页不复活旧错误', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.load.mockRejectedValueOnce(new Error('项目文件不可读'))
    render(<App />)
    await screen.findByTestId('home')
    await attemptOpen('p1')
    warn.mockRestore()
    expect(homeProps.current.openError).not.toBeNull()
    await attemptOpen('p1')
    await screen.findByTestId('editor')
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    await screen.findByTestId('home')
    expect(homeProps.current.openError).toBeNull()
  })

  it('失败后打开另一正常项目：旧错误不带过去', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.list.mockResolvedValue([
      { id: 'p1', name: '雨夜' },
      { id: 'p2', name: '午夜出租车' },
    ])
    store.load.mockImplementation((id: string) =>
      id === 'p1'
        ? Promise.reject(new Error('项目文件不可读'))
        : Promise.resolve({ ...structuredClone(DOC), name: '午夜出租车' }),
    )
    render(<App />)
    await screen.findByTestId('home')
    await attemptOpen('p1')
    warn.mockRestore()
    expect((homeProps.current.openError as { id: string }).id).toBe('p1')
    await attemptOpen('p2')
    await screen.findByTestId('editor')
    expect((editorProps.current.project as { name: string }).name).toBe(
      '午夜出租车',
    )
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    await screen.findByTestId('home')
    expect(homeProps.current.openError).toBeNull()
  })

  it('打开失败后新建项目成功：错误随导航过时，回首页不复活', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.load.mockRejectedValueOnce(new Error('项目文件不可读'))
    render(<App />)
    await screen.findByTestId('home')
    await attemptOpen('p1')
    warn.mockRestore()
    expect(homeProps.current.openError).not.toBeNull()
    await act(async () => {
      ;(homeProps.current.onCreateProject as () => void)()
    })
    await screen.findByTestId('editor')
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    await screen.findByTestId('home')
    expect(homeProps.current.openError).toBeNull()
  })
})

describe('App ✦打开尝试并发收敛（PR #110 评审）', () => {
  it('并发：在途打开被新尝试取代后，迟到的拒绝不发布旧错误也不拦截导航', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let rejectSlow!: (err: Error) => void
    store.list.mockResolvedValue([
      { id: 'slow', name: '慢项目' },
      { id: 'fast', name: '快速项目' },
    ])
    store.load.mockImplementation((id: string) =>
      id === 'slow'
        ? new Promise((_resolve, reject) => {
            rejectSlow = reject
          })
        : Promise.resolve({ ...structuredClone(DOC), name: '快速项目' }),
    )
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      ;(homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'slow',
      )
    })
    await attemptOpen('fast')
    await screen.findByTestId('editor')
    await act(async () => {
      rejectSlow(new Error('文档版本过新（schemaVersion 2），请升级应用'))
    })
    warn.mockRestore()
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    await screen.findByTestId('home')
    expect(homeProps.current.openError).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('并发：两个在途打开都失败，显示后发起尝试的错误而非后完成者', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let rejectFirst!: (err: Error) => void
    store.list.mockResolvedValue([
      { id: 'a', name: '甲' },
      { id: 'b', name: '乙' },
    ])
    store.load.mockImplementation((id: string) =>
      id === 'a'
        ? new Promise((_resolve, reject) => {
            rejectFirst = reject
          })
        : Promise.reject(new Error('乙的失败')),
    )
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      ;(homeProps.current.onOpenProject as (id: string) => Promise<void>)('a')
    })
    await attemptOpen('b')
    warn.mockRestore()
    expect((homeProps.current.openError as { id: string }).id).toBe('b')
    await act(async () => {
      rejectFirst(new Error('甲的失败'))
    })
    expect((homeProps.current.openError as { id: string }).id).toBe('b')
    expect((homeProps.current.openError as { detail: string }).detail).toBe(
      '乙的失败',
    )
  })

  it('并发：被取代的旧尝试成功晚到，不进入编辑器且新失败的横幅保留', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let releaseSlow!: (doc: ProjectContent) => void
    store.list.mockResolvedValue([
      { id: 'a', name: '甲' },
      { id: 'b', name: '乙' },
    ])
    store.load.mockImplementation((id: string) =>
      id === 'a'
        ? new Promise((resolve) => {
            releaseSlow = resolve
          })
        : Promise.reject(new Error('乙的失败')),
    )
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      ;(homeProps.current.onOpenProject as (id: string) => Promise<void>)('a')
    })
    await attemptOpen('b')
    warn.mockRestore()
    expect((homeProps.current.openError as { id: string }).id).toBe('b')
    await act(async () => {
      releaseSlow(structuredClone(DOC))
    })
    expect(screen.queryByTestId('editor')).toBeNull()
    expect((homeProps.current.openError as { id: string }).id).toBe('b')
  })
})

describe('App ✦并发收敛：新建协调（PR #110 评审）', () => {
  it('并发：在途打开的拒绝晚于新建成功，回首页不复活旧横幅', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let rejectSlow!: (err: Error) => void
    store.list.mockResolvedValue([{ id: 'slow', name: '慢项目' }])
    store.load.mockImplementation((id: string) =>
      id === 'slow'
        ? new Promise((_resolve, reject) => {
            rejectSlow = reject
          })
        : Promise.resolve(structuredClone(DOC)),
    )
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      ;(homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'slow',
      )
    })
    await act(async () => {
      ;(homeProps.current.onCreateProject as () => void)()
    })
    await screen.findByTestId('editor')
    await act(async () => {
      rejectSlow(new Error('项目文件不可读'))
    })
    warn.mockRestore()
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    await screen.findByTestId('home')
    expect(homeProps.current.openError).toBeNull()
  })
})

describe('App ✦并发：chunk 挂起窗口内作废排队导航（PR #110 评审）', () => {
  it('新尝试失败时，已排队未提交的旧导航被作废，不得吞掉失败横幅', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.list.mockResolvedValue([
      { id: 'a', name: '甲' },
      { id: 'b', name: '乙' },
    ])
    store.load.mockImplementation((id: string) =>
      id === 'b'
        ? Promise.reject(new Error('乙的失败'))
        : Promise.resolve(structuredClone(DOC)),
    )
    render(<App />)
    await screen.findByTestId('home')
    // 打开甲：发布已排队；挂起门让过渡停在 chunk 加载态，首页保持可交互
    let release!: () => void
    editorSuspendGate = new Promise((resolve) => {
      release = resolve
    })
    await attemptOpen('a')
    expect(screen.queryByTestId('editor')).toBeNull()
    // 挂起窗口内改开乙：乙立即失败并发布横幅
    await attemptOpen('b')
    expect((homeProps.current.openError as { id: string }).id).toBe('b')
    // 放行挂起：被取代的甲不得提交导航吞掉乙的失败横幅
    editorSuspendGate = null
    await act(async () => {
      release()
    })
    warn.mockRestore()
    expect(screen.queryByTestId('editor')).toBeNull()
    expect((homeProps.current.openError as { id: string }).id).toBe('b')
    expect(screen.getByRole('alert').textContent).toContain('乙的失败')
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

  it('AI 会话坏条目隔离后保留可用历史，提示且不自动写回', async () => {
    const recovered = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '已恢复' }],
    }
    store.loadAiSession.mockResolvedValue({
      session: recovered,
      repairError: 'Error: 只读目录',
    })
    await openEditor()
    expect(editorProps.current.aiSession).toEqual(recovered)
    expect(editorProps.current.aiSessionError).toBe('Error: 只读目录')
    // 读取仅展示损坏诊断，不触发挂载保存。
    expect(editorProps.current.aiSessionRetryable).toBe(false)
  })
})

describe('App ✦AI 会话保存', () => {
  it('追加 AI 消息保存成功：编辑器子树零次多余提交（issue #61）', async () => {
    await openEditor()
    const rendersBefore = editorRenders.count
    const session = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '新消息' }],
    }
    await act(async () => {
      await (
        editorProps.current.onSaveAiSession as (
          value: typeof session,
        ) => Promise<void>
      )(session)
    })
    expect(store.saveAiSession).toHaveBeenCalledWith('p1', session)
    expect(editorRenders.count).toBe(rendersBefore)
  })

  it('有加载诊断后实际编辑并保存成功：项目级错误清除，重挂载不再报保存失败', async () => {
    const recovered = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '已恢复' }],
    }
    store.loadAiSession.mockResolvedValue({
      session: recovered,
      repairError: 'Error: 只读目录',
    })
    store.saveAiSession.mockResolvedValue(undefined)
    await openEditor()
    expect(editorProps.current.aiSessionError).toBe('Error: 只读目录')
    const session = {
      schemaVersion: 1 as const,
      entries: [
        ...recovered.entries,
        { id: 2, kind: 'note' as const, text: '新历史' },
      ],
    }
    await (
      editorProps.current.onSaveAiSession as (
        value: typeof session,
      ) => Promise<void>
    )(session)
    await settingsRoundtrip()
    expect(editorProps.current.aiSession).toEqual(session)
    expect(editorProps.current.aiSessionError).toBeNull()
  })

  it('从设置返回时保留本次打开后新增的 AI 会话历史', async () => {
    await openEditor()
    const session = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '新的历史' }],
    }
    await (
      editorProps.current.onSaveAiSession as (
        value: typeof session,
      ) => Promise<void>
    )(session)
    await settingsRoundtrip()
    expect(editorProps.current.aiSession).toEqual(session)
  })

  it('正常加载后用户变更会话：保存失败仍保留内容并允许重试', async () => {
    store.saveAiSession.mockRejectedValueOnce(new Error('磁盘已满'))
    await openEditor()
    expect(editorProps.current.aiSessionRetryable).toBe(false)
    const changed = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '用户的新消息' }],
    }
    await act(async () => {
      await expect(
        (
          editorProps.current.onSaveAiSession as (
            value: typeof changed,
          ) => Promise<void>
        )(changed),
      ).rejects.toThrow('磁盘已满')
    })
    expect(editorProps.current.aiSession).toEqual(changed)
    // 成功加载后的会话变更保留在内存，可重试保存。
    expect(editorProps.current.aiSessionRetryable).toBe(true)
  })
})

describe('App ✦AI 会话保存失败', () => {
  it('会话保存失败时拒绝上浮，错误写入项目级：重挂载不丢警告', async () => {
    store.saveAiSession.mockRejectedValueOnce(new Error('磁盘已满'))
    await openEditor()
    const session = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '未落盘' }],
    }
    await act(async () => {
      await expect(
        (
          editorProps.current.onSaveAiSession as (
            value: typeof session,
          ) => Promise<void>
        )(session),
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
        (
          editorProps.current.onSaveAiSession as (
            value: typeof changed,
          ) => Promise<void>
        )(changed),
      ).rejects.toThrow('磁盘已满')
    })
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    expect(await screen.findByTestId('home')).toBeTruthy()
    // 重开同一项目：磁盘上是旧会话，但内存保留的未落盘会话胜出并标记可重试
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'p1',
      )
    })
    await screen.findByTestId('editor')
    expect(editorProps.current.aiSession).toEqual(changed)
    expect(editorProps.current.aiSessionError).toContain('磁盘已满')
    expect(editorProps.current.aiSessionRetryable).toBe(true)
  })
})

describe('App ✦AI 会话重试成功通知', () => {
  it('退出重试补写成功：清除项目级错误与保留快照，重开不再以内存会话胜出', async () => {
    store.saveAiSession.mockRejectedValueOnce(new Error('磁盘已满'))
    await openEditor()
    const changed = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '未落盘' }],
    }
    await act(async () => {
      await expect(
        (
          editorProps.current.onSaveAiSession as (
            value: typeof changed,
          ) => Promise<void>
        )(changed),
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
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'p1',
      )
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
        (
          editorProps.current.onSaveAiSession as (
            value: typeof changed,
          ) => Promise<void>
        )(changed),
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
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject
        }),
    )
    const changed = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '在途未落盘' }],
    }
    await act(async () => {
      ;(
        editorProps.current.onSaveAiSession as (
          value: typeof changed,
        ) => Promise<void>
      )(changed).catch(() => undefined)
    })
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    expect(await screen.findByTestId('home')).toBeTruthy()

    // 重开：load 挂起期间保存拒绝落定（保留区在屏障内被写入）
    let releaseLoad!: (doc: ProjectContent) => void
    store.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseLoad = resolve
        }),
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

describe('App 会话读取失败边界', () => {
  it('读取失败禁用 AI，画布继续打开；重开读取成功后解除', async () => {
    const history = {
      schemaVersion: 1,
      entries: [{ id: 1, kind: 'note', text: '原有历史' }],
    }
    store.loadAiSession.mockResolvedValue({
      session: history,
      repairError: null,
    })
    store.loadAiSession.mockRejectedValueOnce(new Error('临时读取失败'))
    await openEditor()
    expect(editorProps.current.aiSessionLoadFailed).toBe(true)
    expect(editorProps.current.project).toBeTruthy()
    await settingsRoundtrip()
    expect(editorProps.current.aiSessionLoadFailed).toBe(true)
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    await screen.findByTestId('home')
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'p1',
      )
    })
    await screen.findByTestId('editor')
    expect(editorProps.current.aiSessionLoadFailed).toBe(false)
    expect(editorProps.current.aiSession).toEqual(history)
    expect(store.saveAiSession).not.toHaveBeenCalled()
  })
})

describe('App ✦AI 会话回吐重排失败恢复', () => {
  it('墓碑吸收的会话补写失败：事件登记恢复快照，重开内存副本胜出并提示可重试', async () => {
    await openEditor()
    const retained = {
      schemaVersion: 1 as const,
      entries: [{ id: 1, kind: 'note' as const, text: '墓碑期消息' }],
    }
    // 删除失败回吐重排失败：原始保存已被吸收为成功，失败只能经事件上浮
    await act(async () => {
      replayFailedListeners.forEach((listener) =>
        listener('p1', { session: retained, error: 'Error: 磁盘仍满' }),
      )
    })
    await act(async () => {
      ;(editorProps.current.onBackHome as () => void)()
    })
    expect(await screen.findByTestId('home')).toBeTruthy()
    // 重开同一项目：磁盘是旧会话，事件登记的恢复快照胜出并提示可重试
    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)(
        'p1',
      )
    })
    await screen.findByTestId('editor')
    expect(editorProps.current.aiSession).toEqual(retained)
    expect(editorProps.current.aiSessionError).toContain('磁盘仍满')
    expect(editorProps.current.aiSessionRetryable).toBe(true)
  })
})
