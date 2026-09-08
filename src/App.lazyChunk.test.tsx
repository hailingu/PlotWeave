// @vitest-environment happy-dom
/**
 * App 惰性 chunk 加载的回归防护（issue #34 评审 P2）：
 * 编辑器动态导入未就绪时必须保留当前界面——若切换瞬间整窗被
 * Suspense fallback(null) 清空即为回归。编辑器模块经手动阀门
 * 停在 pending，以观察加载中的中间态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import App from './App'
import { projectStore } from './projectStore'
import type { ProjectContent } from './projectStore'

/** 动态导入放行阀门：resolve 前 import('./editor/EditorView') 一直 pending。 */
const editorGate = vi.hoisted(() => ({
  resolve: null as null | ((mod: unknown) => void),
}))
vi.mock('./editor/EditorView', () => new Promise((resolve) => {
  editorGate.resolve = resolve as (mod: unknown) => void
}))

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
    return <div data-testid="home">{props.loading ? '加载中' : '首页'}</div>
  },
}))

const homeProps: { current: Record<string, unknown> } = { current: {} }

const store = projectStore as unknown as {
  list: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
}

const DOC: ProjectContent = {
  name: '雨夜',
  nodes: [],
  edges: [],
  settings: { characters: [], locations: [] },
}

/** 编辑器 chunk 就绪后的替身视图。 */
function EditorStub(): ReactNode {
  return <div data-testid="editor">编辑器</div>
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  editorGate.resolve = null
  store.list.mockResolvedValue([{ id: 'p1', name: '雨夜' }])
  store.load.mockResolvedValue(structuredClone(DOC))
})

describe('App（惰性 chunk 加载保留当前界面）', () => {
  it('编辑器 chunk 未就绪时首页保持可见；就绪后完成切换', async () => {
    render(<App />)
    await screen.findByTestId('home')

    await act(async () => {
      await (homeProps.current.onOpenProject as (id: string) => Promise<void>)('p1')
    })
    // 越过 React 对已显示边界的 fallback 防闪白节流（~300ms）再观察中间态
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700))
    })
    // chunk 加载中：窗口不得整片空白（fallback null 卸载首页即为回归）
    expect(screen.getByTestId('home')).toBeTruthy()
    expect(screen.queryByTestId('editor')).toBeNull()

    // chunk 就绪：放行动态导入，编辑器视图替换首页
    await act(async () => {
      editorGate.resolve?.({ default: EditorStub as ComponentType })
    })
    expect(await screen.findByTestId('editor')).toBeTruthy()
  })
})
