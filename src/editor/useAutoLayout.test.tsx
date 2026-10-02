// @vitest-environment happy-dom
/**
 * 自动排布 hook 测试（issue #94）：一次排布 = 一个撤销单元、无位移不入栈、
 * 排布后适配视图、计算失败保留原布局并上浮可读反馈、空画布安全无操作。
 * 以真实 useEditorDocument 组合，只断言画布状态与命令栈行为。
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Edge, FitView } from '@xyflow/react'
import {
  useEditorDocument,
  type EditorProjectContent,
} from './useEditorDocument'
import { useAutoLayout } from './useAutoLayout'
import type { HistoryCommand } from './history'
import type { CanvasNode } from './nodes/types'
import type { XYPosition } from '@xyflow/react'

afterEach(() => {
  vi.restoreAllMocks()
})

const sceneNode = (id: string, x: number, y: number) =>
  ({
    id,
    type: 'scene',
    position: { x, y },
    measured: { width: 340, height: 200 },
    data: {
      name: id,
      sceneNo: 1,
      interior: true,
      time: '',
      synopsis: '',
      characterIds: [],
    },
  }) as unknown as CanvasNode

/** 未测量且无落盘尺寸的节拍卡：.pw-beat 为 max-content，宽度随文本无上界。 */
const unmeasuredBeat = (id: string, x: number, y: number) =>
  ({
    id,
    type: 'beat',
    position: { x, y },
    data: { name: '一段非常长的节拍名称会把胶囊卡片撑到回退宽度之外' },
  }) as unknown as CanvasNode

const seqEdge = (source: string, target: string): Edge => ({
  id: `e-${source}-${target}`,
  source,
  target,
  className: 'pw-edge-sequence',
})

function makeProject(nodes: CanvasNode[], edges: Edge[]): EditorProjectContent {
  return {
    id: 'p1',
    name: '排布测试',
    nodes,
    edges,
    settings: { characters: [], locations: [] },
  }
}

function setup(
  project: EditorProjectContent,
  overrides: {
    computeLayout?: typeof import('./autoLayout').computeAutoLayout
  } = {},
) {
  const commands: HistoryCommand[] = []
  const pushHistory = vi.fn((cmd: HistoryCommand) => commands.push(cmd))
  const fitView = vi.fn()
  const onError = vi.fn()
  // rAF 同步执行：断言 fitView 的调用时机不依赖真实帧调度
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
    (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    },
  )
  const { result } = renderHook(() => {
    const doc = useEditorDocument(project)
    const layout = useAutoLayout({
      nodesRef: doc.nodesRef,
      edgesRef: doc.edgesRef,
      setNodes: doc.setNodes,
      pushHistory,
      fitView: fitView as unknown as FitView,
      onError,
      ...overrides,
    })
    return { doc, layout }
  })
  return { result, commands, pushHistory, fitView, onError }
}

const positionsOf = (nodes: CanvasNode[]) =>
  new Map(nodes.map((n) => [n.id, { ...n.position }] as const))

describe('useAutoLayout · 撤销单元与视图适配（issue #94）', () => {
  it('散乱节点一键排布：整图换位、入栈一个撤销单元，撤销恢复全部原位置、重做恢复排布', () => {
    const project = makeProject(
      [
        sceneNode('s1', 0, 0),
        sceneNode('s2', 800, 600),
        sceneNode('s3', -400, 900),
      ],
      [seqEdge('s1', 's2'), seqEdge('s2', 's3')],
    )
    const { result, commands, pushHistory, fitView } = setup(project)
    const before = positionsOf(result.current.doc.nodes)

    act(() => result.current.layout.onAutoLayout())

    expect(pushHistory).toHaveBeenCalledTimes(1)
    expect(commands).toHaveLength(1)
    const after = positionsOf(result.current.doc.nodes)
    expect(after.get('s1')!.x).toBeLessThan(after.get('s2')!.x)
    expect(after.get('s2')!.x).toBeLessThan(after.get('s3')!.x)
    expect(fitView).toHaveBeenCalledTimes(1)

    act(() => commands[0].undo())
    expect(positionsOf(result.current.doc.nodes)).toEqual(before)

    act(() => commands[0].redo())
    expect(positionsOf(result.current.doc.nodes)).toEqual(after)
  })

  it('排布不改动节点与边的内容、类型与连接端点', () => {
    const project = makeProject(
      [sceneNode('s1', 0, 0), sceneNode('s2', 800, 600)],
      [seqEdge('s1', 's2')],
    )
    const { result } = setup(project)
    const beforeNodes = result.current.doc.nodes
    const beforeEdges = result.current.doc.edges

    act(() => result.current.layout.onAutoLayout())

    const afterNodes = result.current.doc.nodes
    expect(afterNodes.map((n) => n.id)).toEqual(beforeNodes.map((n) => n.id))
    expect(afterNodes.map((n) => n.type)).toEqual(
      beforeNodes.map((n) => n.type),
    )
    expect(afterNodes.map((n) => n.data)).toEqual(
      beforeNodes.map((n) => n.data),
    )
    const moved = afterNodes.filter((n) => {
      const b = positionsOf(beforeNodes).get(n.id) as XYPosition
      return b.x !== n.position.x || b.y !== n.position.y
    })
    expect(moved.length).toBeGreaterThan(0)
    expect(result.current.doc.edges).toEqual(beforeEdges)
  })
})

describe('useAutoLayout · 安全边界（issue #94）', () => {
  it('无位置变化时不增加无意义历史记录', () => {
    const { result, pushHistory, fitView, onError } = setup(
      makeProject([sceneNode('s1', 0, 0)], []),
    )
    act(() => result.current.layout.onAutoLayout())
    expect(pushHistory).not.toHaveBeenCalled()
    expect(fitView).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('计算失败时保留原布局并上浮可读反馈，不提交部分位置', () => {
    const project = makeProject(
      [sceneNode('s1', 100, 100), sceneNode('s2', 900, 700)],
      [seqEdge('s1', 's2')],
    )
    const { result, commands, pushHistory, onError } = setup(project, {
      computeLayout: () => {
        throw new Error('布局引擎异常')
      },
    })
    const before = positionsOf(result.current.doc.nodes)

    act(() => result.current.layout.onAutoLayout())

    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0][0])).toContain('自动排布失败')
    expect(String(onError.mock.calls[0][0])).toContain('布局引擎异常')
    expect(pushHistory).not.toHaveBeenCalled()
    expect(commands).toHaveLength(0)
    expect(positionsOf(result.current.doc.nodes)).toEqual(before)
  })

  it('空画布安全无操作', () => {
    const { result, pushHistory, fitView, onError } = setup(makeProject([], []))
    act(() => result.current.layout.onAutoLayout())
    expect(pushHistory).not.toHaveBeenCalled()
    expect(fitView).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('useAutoLayout · 测量守卫与减少动态（PR #111 评审）', () => {
  it('存在未测量节点（max-content 节拍卡）时保留原布局并提示稍后重试', () => {
    const project = makeProject(
      [sceneNode('s1', 0, 0), unmeasuredBeat('bt1', 800, 600)],
      [seqEdge('s1', 'bt1')],
    )
    const { result, commands, pushHistory, fitView, onError } = setup(project)
    const before = positionsOf(result.current.doc.nodes)

    act(() => result.current.layout.onAutoLayout())

    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0][0])).toContain('尺寸测量')
    expect(pushHistory).not.toHaveBeenCalled()
    expect(commands).toHaveLength(0)
    expect(fitView).not.toHaveBeenCalled()
    expect(positionsOf(result.current.doc.nodes)).toEqual(before)
  })

  it('减少动态偏好下视口适配降级为无插值即时适配（§2.6）', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
    })) as unknown as typeof window.matchMedia)
    const project = makeProject(
      [sceneNode('s1', 0, 0), sceneNode('s2', 800, 600)],
      [seqEdge('s1', 's2')],
    )
    const { result, fitView } = setup(project)
    act(() => result.current.layout.onAutoLayout())
    expect(fitView).toHaveBeenCalledWith(
      expect.objectContaining({ duration: 0 }),
    )
  })

  it('默认动效下视口适配保留 400ms 动画', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((() => ({
      matches: false,
    })) as unknown as typeof window.matchMedia)
    const project = makeProject(
      [sceneNode('s1', 0, 0), sceneNode('s2', 800, 600)],
      [seqEdge('s1', 's2')],
    )
    const { result, fitView } = setup(project)
    act(() => result.current.layout.onAutoLayout())
    expect(fitView).toHaveBeenCalledWith(
      expect.objectContaining({ duration: 400 }),
    )
  })
})
