// @vitest-environment happy-dom
/** 真实 React Flow 单／多选拖动只执行变更卡片；计数包装保留真实场景卡片和编辑会话。 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from './EditorView'
import type { EditorProjectContent } from './useEditorDocument'
import type { SceneFlowNode } from './nodes/types'

/** 只记录实际场景组件执行次数，不替换卡片内容或 React Flow。 */
const executions = vi.hoisted(() => new Map<string, number>())

vi.mock('./nodes/SceneNode', async (original) => {
  const actual = await original<typeof import('./nodes/SceneNode')>()
  return {
    ...actual,
    SceneNode: (props: Parameters<typeof actual.SceneNode>[0]) => {
      executions.set(props.id, (executions.get(props.id) ?? 0) + 1)
      return <actual.SceneNode {...props} />
    },
  }
})

/** 宿主标记只选择生产 Swift 接线；测试服务不会读取用户数据。 */
const host = window as Window & { __pwNativeHost?: unknown; webkit?: unknown }

afterEach(() => {
  cleanup()
  executions.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete host.__pwNativeHost
  delete host.webkit
})

/** 固定场景有实测尺寸，避免测量通知或内容差异混入位置帧。 */
function scene(id: string, x: number, selected: boolean): SceneFlowNode {
  return {
    id,
    type: 'scene',
    position: { x, y: 0 },
    width: 240,
    height: 120,
    selected,
    data: {
      name: id,
      sceneNo: 1,
      interior: false,
      time: '夜',
      synopsis: '拖动范围回归',
      characterIds: [],
    },
  }
}

/** 三张真实场景卡足以抓住点击回调引用导致的全图重渲染。 */
async function mount(swift: boolean, multiple = false) {
  vi.useFakeTimers()
  // Happy DOM 没有布局；给画布固定尺寸并把拖动置于中央，避免测试触发自动平移。
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 1200, 800),
  )
  if (swift) {
    host.__pwNativeHost = {
      kind: 'swift',
      protocolVersion: 1,
      sessionId: 'render-isolation',
    }
    host.webkit = {
      messageHandlers: {
        canvasHost: { postMessage: () => undefined },
        plotweaveHost: { postMessage: async () => ({ ok: {} }) },
      },
    }
  }
  const project: EditorProjectContent = {
    id: 'node-render',
    name: '单节点拖动隔离',
    nodes: [
      scene('a', 0, true),
      scene('b', 400, multiple),
      scene('c', 800, false),
    ],
    edges: [],
    settings: { characters: [], locations: [] },
    viewport: { x: 300, y: 300, zoom: 1 },
  }
  const view = render(
    <EditorView
      project={project}
      onBackHome={() => undefined}
      onRenameProject={() => undefined}
      onSave={() => undefined}
    />,
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  for (const id of ['a', 'b', 'c'])
    expect(
      within(view.getByTestId(`rf__node-${id}`)).getByText('拖动范围回归'),
    ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '网格吸附：开' }))
  return view
}

/** 实际鼠标移动进入框架位置通道，参数保持同一按下状态。 */
function move(clientX: number): void {
  fireEvent.mouseMove(window, {
    clientX: clientX + 300,
    clientY: 310,
    buttons: 1,
    view: window,
  })
}

/** 在第一段位置提交后建立基线，避免把拖动起始选择计入后续位置帧。 */
function start(node: HTMLElement): void {
  fireEvent.mouseDown(node, {
    clientX: 310,
    clientY: 310,
    button: 0,
    buttons: 1,
    view: window,
  })
  move(14)
  move(30)
}

/** 松手沿原历史入口完成一段，并排空 d3 的临时点击抑制，避免污染下一个手势。 */
async function stop(): Promise<void> {
  fireEvent.mouseUp(window, {
    clientX: 400,
    clientY: 310,
    button: 0,
    view: window,
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe('真实节点拖动的渲染范围', () => {
  it.each([
    { swift: false, diagnostics: false },
    { swift: true, diagnostics: false },
    { swift: false, diagnostics: true },
    { swift: true, diagnostics: true },
  ])(
    '单节点位置帧不执行无关卡片（Swift=$swift，诊断=$diagnostics）',
    async ({ swift, diagnostics }) => {
      const view = await mount(swift)
      if (diagnostics) {
        vi.spyOn(console, 'info').mockImplementation(() => undefined)
        fireEvent.click(screen.getByRole('button', { name: '性能诊断：关' }))
      }
      const node = view.getByTestId('rf__node-a')
      start(node)
      const before = new Map(executions)
      move(50)
      move(80)
      move(100)
      expect(node.style.transform).toBe('translate(86px,0px)')
      expect(executions.get('a')).toBeGreaterThan(before.get('a') ?? 0)
      expect(executions.get('b')).toBe(before.get('b'))
      expect(executions.get('c')).toBe(before.get('c'))
      expect(view.getByTestId('rf__node-b').style.transform).toBe(
        'translate(400px,0px)',
      )
      await stop()
    },
  )

  it('多选拖动更新被拖卡片并保留整组一步撤销', async () => {
    const view = await mount(false, true)
    start(view.getByTestId('rf__node-a'))
    const before = new Map(executions)
    move(50)
    move(80)
    move(100)
    expect(executions.get('a')).toBeGreaterThan(before.get('a') ?? 0)
    expect(executions.get('b')).toBeGreaterThan(before.get('b') ?? 0)
    expect(executions.get('c')).toBe(before.get('c'))
    await stop()
    expect(view.getByTestId('rf__node-a').style.transform).toBe(
      'translate(86px,0px)',
    )
    expect(view.getByTestId('rf__node-b').style.transform).toBe(
      'translate(486px,0px)',
    )
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(view.getByTestId('rf__node-a').style.transform).toBe(
      'translate(0px,0px)',
    )
    expect(view.getByTestId('rf__node-b').style.transform).toBe(
      'translate(400px,0px)',
    )
    expect(
      (screen.getByRole('button', { name: '撤销' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })
})
