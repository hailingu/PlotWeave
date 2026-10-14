// @vitest-environment happy-dom
/**
 * App 打开/新建尝试域测试（issue #525 自 App.test.tsx 拆分）：打开失败
 * 的横幅反馈与错误清理时机（issue #98）、打开/新建尝试的并发收敛
 * （PR #110 评审：被取代尝试的迟到结果不发布）与 chunk 挂起窗口内的
 * 排队导航作废。子视图与 projectStore 桩经 appShellTestScaffolding 委托。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { App } from './App'
import type { ProjectContent } from './projectStore'
import {
  attemptOpen,
  DOC,
  editorProps,
  editorSuspendGate,
  homeProps,
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

afterEach(cleanup)

beforeEach(() => resetAppShellFixture())

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
    editorSuspendGate.promise = new Promise((resolve) => {
      release = resolve
    })
    await attemptOpen('a')
    expect(screen.queryByTestId('editor')).toBeNull()
    // 挂起窗口内改开乙：乙立即失败并发布横幅
    await attemptOpen('b')
    expect((homeProps.current.openError as { id: string }).id).toBe('b')
    // 放行挂起：被取代的甲不得提交导航吞掉乙的失败横幅
    editorSuspendGate.promise = null
    await act(async () => {
      release()
    })
    warn.mockRestore()
    expect(screen.queryByTestId('editor')).toBeNull()
    expect((homeProps.current.openError as { id: string }).id).toBe('b')
    expect(screen.getByRole('alert').textContent).toContain('乙的失败')
  })
})
