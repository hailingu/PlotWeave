// @vitest-environment happy-dom
/** #663：真实编辑器中的区域故障不得卸载保存/历史所有者或其他区域。 */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../ErrorBoundary'
import { EditorView } from './EditorView'
import type { EditorProjectContent } from './useEditorDocument'

const faults = vi.hoisted(() => ({
  left: null as Error | null,
  canvas: null as Error | null,
  right: null as Error | null,
  overlays: null as Error | null,
}))

vi.mock('./panels/LeftPanel', async (original) => {
  const actual = await original<typeof import('./panels/LeftPanel')>()
  return {
    ...actual,
    LeftPanel: (props: ComponentProps<typeof actual.LeftPanel>) => {
      if (faults.left) throw faults.left
      return <actual.LeftPanel {...props} />
    },
  }
})
vi.mock('./panels/RightPanel', async (original) => {
  const actual = await original<typeof import('./panels/RightPanel')>()
  return {
    ...actual,
    RightPanel: (props: ComponentProps<typeof actual.RightPanel>) => {
      if (faults.right) throw faults.right
      return <actual.RightPanel {...props} />
    },
  }
})
vi.mock('./EditorCanvasRegion', async (original) => {
  const actual = await original<typeof import('./EditorCanvasRegion')>()
  return {
    ...actual,
    EditorCanvasRegion: (
      props: ComponentProps<typeof actual.EditorCanvasRegion>,
    ) => {
      if (faults.canvas) throw faults.canvas
      return <actual.EditorCanvasRegion {...props} />
    },
  }
})
vi.mock('./EditorOverlays', async (original) => {
  const actual = await original<typeof import('./EditorOverlays')>()
  return {
    ...actual,
    EditorOverlays: (props: ComponentProps<typeof actual.EditorOverlays>) => {
      if (faults.overlays) throw faults.overlays
      return <actual.EditorOverlays {...props} />
    },
  }
})

const PROJECT: EditorProjectContent = {
  id: 'regional-editor',
  name: '区域恢复',
  nodes: [],
  edges: [],
  settings: { characters: [], locations: [] },
}
const LABELS = {
  left: '左侧面板',
  canvas: '画布',
  right: '右侧面板',
  overlays: '浮层',
}

beforeEach(() => {
  vi.useFakeTimers()
  for (const key of Object.keys(faults) as (keyof typeof faults)[])
    faults[key] = null
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(async () => {
  await act(async () => cleanup())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** 保留真实控制器、四个区域与根兜底；只由模块代理注入渲染异常。 */
function mount(onSave = vi.fn(), project = PROJECT) {
  const props = {
    project,
    onSave,
    onBackHome: vi.fn(),
    onRenameProject: vi.fn(),
  }
  const content = (
    overrides: Partial<ComponentProps<typeof EditorView>> = {},
  ) => (
    <ErrorBoundary>
      <EditorView {...props} {...overrides} />
    </ErrorBoundary>
  )
  const view = render(content())
  return {
    ...view,
    onSave,
    refresh: (overrides: Partial<ComponentProps<typeof EditorView>> = {}) =>
      view.rerender(content(overrides)),
  }
}

/** 使用真实命令入口；保存与撤销不能由区域测试替身实现。 */
function createScene() {
  fireEvent.click(screen.getByLabelText('新增节点'))
  fireEvent.click(screen.getByRole('menuitem', { name: '场景' }))
}

it.each(['left', 'canvas', 'right', 'overlays'] as const)(
  '%s 故障只替换本区，其他 DOM、文档、命令栈和保存继续工作',
  async (region) => {
    const view = mount()
    createScene()
    const healthySelector =
      region === 'left' ? '.pw-panel-right' : '.pw-panel-left'
    const healthy = document.querySelector(healthySelector)
    expect(healthy).not.toBeNull()
    const failure = new Error(`injected-${region}`)
    faults[region] = failure
    view.refresh()
    expect(screen.getByText(`${LABELS[region]}暂时不可用`)).toBeTruthy()
    expect(screen.queryByText('界面出错了')).toBeNull()
    expect(document.querySelector(healthySelector)).toBe(healthy)
    createScene()
    fireEvent.click(screen.getByLabelText('撤销'))
    await act(async () => vi.advanceTimersByTimeAsync(600))
    expect(view.onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ nodes: [expect.any(Object)] }),
    )
    expect(
      screen.getByRole('status', { name: '画布保存状态' }).textContent,
    ).toContain('已保存')
    expect(console.error).toHaveBeenCalledWith(
      '[PlotWeave] 区域渲染失败',
      expect.objectContaining({ code: 'EDITOR_REGION_RENDER_FAILED', region }),
      failure,
      expect.stringContaining(
        region === 'canvas'
          ? 'EditorCanvasRegion'
          : region === 'overlays'
            ? 'EditorOverlays'
            : region === 'left'
              ? 'LeftPanel'
              : 'RightPanel',
      ),
      {
        level: 'ERROR',
        target: 'plotweave::frontend::editor',
        code: 'EDITOR_REGION_RENDER_FAILED',
        message: '[PlotWeave] 区域渲染失败',
      },
    )
    faults[region] = null
    view.refresh()
    expect(screen.getByText(`${LABELS[region]}暂时不可用`)).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: `重试${LABELS[region]}` }),
    )
    expect(screen.queryByText(`${LABELS[region]}暂时不可用`)).toBeNull()
    expect(document.querySelector(healthySelector)).toBe(healthy)
  },
)

it('保存失败与自动重试横幅不被右栏失败遮蔽', async () => {
  const onSave = vi
    .fn()
    .mockRejectedValueOnce(new Error('磁盘暂不可写'))
    .mockResolvedValue(undefined)
  const view = mount(onSave)
  createScene()
  faults.right = new Error('right render')
  view.refresh()
  await act(async () => vi.advanceTimersByTimeAsync(600))
  expect(
    screen.getByRole('status', { name: '画布保存状态' }).textContent,
  ).toContain('保存失败')
  expect(
    screen
      .getAllByRole('alert')
      .some((a) => a.textContent?.includes('磁盘暂不可写')),
  ).toBe(true)
  await act(async () => vi.advanceTimersByTimeAsync(600))
  expect(onSave).toHaveBeenCalledTimes(2)
  expect(
    screen.getByRole('status', { name: '画布保存状态' }).textContent,
  ).toContain('已保存')
  expect(screen.getByText('右侧面板暂时不可用')).toBeTruthy()
})

it('失败的导出浮层可关闭，清理模态标记后全局撤销仍可用', async () => {
  const view = mount()
  createScene()
  faults.overlays = new Error('export render')
  fireEvent.click(screen.getByRole('button', { name: '导出剧本' }))
  expect(screen.getByText('浮层暂时不可用')).toBeTruthy()
  faults.overlays = null
  fireEvent.click(screen.getByRole('button', { name: '关闭浮层' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.keyDown(document.body, { key: 'z', metaKey: true, ctrlKey: true })
  await act(async () => vi.advanceTimersByTimeAsync(600))
  expect(view.onSave).toHaveBeenLastCalledWith(
    expect.objectContaining({ nodes: [] }),
  )
  fireEvent.click(screen.getByRole('button', { name: '导出剧本' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
})

it('原生宿主隐藏的右栏崩溃仍显示可重试错误，保留生产编辑器注册', () => {
  vi.stubGlobal('__pwNativeHost', {
    kind: 'swift',
    protocolVersion: 1,
    sessionId: 'region-test',
  })
  vi.stubGlobal('webkit', {
    messageHandlers: {
      canvasHost: { postMessage: vi.fn() },
      plotweaveHost: { postMessage: async () => ({ ok: {} }) },
    },
  })
  const view = mount()
  const canvas = document.querySelector('.react-flow')
  expect(canvas).not.toBeNull()
  faults.right = new Error('hidden native ai')
  view.refresh()
  expect(screen.getByRole('alert').textContent).toContain('右侧面板暂时不可用')
  expect(
    screen
      .getByRole('button', { name: '重试右侧面板' })
      .closest('[aria-hidden="true"]'),
  ).toBeNull()
  expect(document.querySelector('.react-flow')).toBe(canvas)
  expect('__pwNativeIntent' in window && typeof window.__pwNativeIntent).toBe(
    'function',
  )
})

it('左栏文档弹窗随故障卸载后，手动重试结束旧模态并恢复快捷键', async () => {
  const project: EditorProjectContent = {
    ...PROJECT,
    settings: {
      characters: [],
      locations: [],
      documents: [
        { id: 'doc', title: '人物小传', body: '陈默。', relatedIds: [] },
      ],
    },
  }
  const view = mount(vi.fn(), project)
  createScene()
  fireEvent.click(screen.getByRole('button', { name: '设定集' }))
  fireEvent.click(screen.getByRole('button', { name: '打开文档 人物小传' }))
  expect(screen.getByRole('dialog', { name: '编辑设定文档' })).toBeTruthy()
  faults.left = new Error('document subtree render')
  view.refresh()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByText('左侧面板暂时不可用')).toBeTruthy()
  faults.left = null
  fireEvent.click(screen.getByRole('button', { name: '重试左侧面板' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.keyDown(document.body, { key: 'z', metaKey: true })
  await act(async () => vi.advanceTimersByTimeAsync(600))
  expect(view.onSave).toHaveBeenLastCalledWith(
    expect.objectContaining({ nodes: [] }),
  )
})

it('右栏失败后上层 AI 会话读写错误仍随最新状态可见', () => {
  const view = mount()
  faults.right = new Error('right presentation failed')
  view.refresh()
  view.refresh({ aiSessionError: 'AI 会话磁盘只读' })
  expect(screen.getByRole('alert').textContent).toContain('AI 会话磁盘只读')
  view.refresh({ aiSessionError: null })
  expect(screen.queryByText(/AI 会话磁盘只读/)).toBeNull()
  expect(screen.getByText('右侧面板暂时不可用')).toBeTruthy()
})
