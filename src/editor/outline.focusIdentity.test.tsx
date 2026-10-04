// @vitest-environment jsdom
/**
 * 集聚焦投影的身份稳定性（issue #273）：`applyEpisodeFocus` 对未变化的
 * 非成员节点复用同一压暗投影对象，使 React Flow 的 `adoptUserNodes`
 * （`checkEquality`：userNode 身份不变即复用内部节点）跳过重建，节点
 * 组件不因无关节点移动而重渲染。消费侧证据用真实 React Flow 装配 +
 * 渲染计数探针节点类型测量；聚焦切换/换集/换宿主/位置变化仍须及时更新。
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import { useMemo, useState } from 'react'
import { applyEpisodeFocus } from './outline'
import { SCENE_SHOT_HANDLE } from './graphRules'
import type { CanvasNode } from './nodes/types'

afterEach(cleanup)

// jsdom 无 ResizeObserver（真实画布装配需要）；本测只计渲染，无操作桩即可
if (typeof ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

const node = (
  id: string,
  type: CanvasNode['type'],
  x: number,
  data: Record<string, unknown>,
): CanvasNode =>
  ({ id, type, position: { x, y: 0 }, data }) as unknown as CanvasNode

/** 集1 两节点、集2 两节点、未分集场景 + 其下挂分镜（随宿主归集）。 */
function graph(): { nodes: CanvasNode[]; edges: Edge[] } {
  return {
    nodes: [
      node('a1', 'scene', 0, { name: 'A1', sceneNo: 1, episodeNo: 1 }),
      node('a2', 'beat', 100, { name: 'A2', tone: '', episodeNo: 1 }),
      node('b1', 'scene', 200, { name: 'B1', sceneNo: 2, episodeNo: 2 }),
      node('b2', 'beat', 300, { name: 'B2', tone: '', episodeNo: 2 }),
      node('s3', 'scene', 400, { name: 'S3', sceneNo: 3 }),
      node('sh3', 'shot', 400, { shotNo: 1, size: '特写' }),
    ],
    edges: [
      {
        id: 'e-attach',
        source: 's3',
        sourceHandle: SCENE_SHOT_HANDLE,
        target: 'sh3',
      },
    ],
  }
}

const byId = (nodes: CanvasNode[]) => new Map(nodes.map((n) => [n.id, n]))

describe('applyEpisodeFocus 投影身份（issue #273）', () => {
  it('同一输入连续两次：非成员投影对象身份不变，成员即输入本身', () => {
    const { nodes, edges } = graph()
    const first = byId(applyEpisodeFocus(nodes, edges, 1))
    const second = byId(applyEpisodeFocus(nodes, edges, 1))
    for (const id of ['b1', 'b2', 's3', 'sh3']) {
      expect(first.get(id)).toBe(second.get(id))
      expect(first.get(id)?.className).toBe('pw-node-dim')
      expect(first.get(id)).not.toBe(byId(nodes).get(id))
    }
    expect(first.get('a1')).toBe(byId(nodes).get('a1'))
    expect(first.get('a2')).toBe(byId(nodes).get('a2'))
  })

  it('仅一个非成员被替换（位置变化）：其余非成员投影身份保持，被替换者刷新', () => {
    const { nodes, edges } = graph()
    const before = byId(applyEpisodeFocus(nodes, edges, 1))
    const moved = nodes.map((n) =>
      n.id === 'b1' ? { ...n, position: { x: 999, y: 0 } } : n,
    )
    const after = byId(applyEpisodeFocus(moved, edges, 1))
    expect(after.get('b1')).not.toBe(before.get('b1'))
    expect(after.get('b1')?.position.x).toBe(999)
    expect(after.get('b1')?.className).toBe('pw-node-dim')
    for (const id of ['b2', 's3', 'sh3']) {
      expect(after.get(id)).toBe(before.get(id))
    }
  })

  it('聚焦切换与取消：成员/非成员按新聚焦即时重算，取消返回原数组', () => {
    const { nodes, edges } = graph()
    const src = byId(nodes)
    const f2 = byId(applyEpisodeFocus(nodes, edges, 2))
    expect(f2.get('b1')).toBe(src.get('b1'))
    expect(f2.get('a1')?.className).toBe('pw-node-dim')
    expect(applyEpisodeFocus(nodes, edges, null)).toBe(nodes)
  })

  it('分镜换宿主：节点对象未变、边变化时归集随宿主即时更新', () => {
    const { nodes, edges } = graph()
    const src = byId(nodes)
    expect(byId(applyEpisodeFocus(nodes, edges, 1)).get('sh3')?.className).toBe(
      'pw-node-dim',
    )
    const rehosted: Edge[] = [
      {
        id: 'e2',
        source: 'a1',
        sourceHandle: SCENE_SHOT_HANDLE,
        target: 'sh3',
      },
    ]
    expect(byId(applyEpisodeFocus(nodes, rehosted, 1)).get('sh3')).toBe(
      src.get('sh3'),
    )
  })

  it('节点换集：数据变化产生新对象，投影不沿用旧压暗对象', () => {
    const { nodes, edges } = graph()
    const before = byId(applyEpisodeFocus(nodes, edges, 1))
    const changed = nodes.map((n) =>
      n.id === 'b1' ? { ...n, data: { ...n.data, episodeNo: 1 } } : n,
    ) as CanvasNode[]
    const after = byId(applyEpisodeFocus(changed, edges, 1))
    expect(after.get('b1')).toBe(byId(changed).get('b1'))
    expect(after.get('b1')?.className).toBeUndefined()
    expect(before.get('b1')?.className).toBe('pw-node-dim')
  })

  it('投影不回写真源：输入节点不带 className', () => {
    const { nodes, edges } = graph()
    applyEpisodeFocus(nodes, edges, 1)
    for (const n of nodes) expect(n.className).toBeUndefined()
  })
})

/** 渲染计数探针：每个节点 id 的节点组件执行次数（真实 React Flow 装配驱动）。 */
const renders = new Map<string, number>()
function Probe({ id }: NodeProps) {
  renders.set(id, (renders.get(id) ?? 0) + 1)
  return <div>{id}</div>
}
const nodeTypes: NodeTypes = {
  scene: Probe,
  beat: Probe,
  shot: Probe,
}

let harness: { move: (id: string, x: number) => void } | null = null

/** 最小消费侧装配：useMemo 投影 → 真实 ReactFlow（与 useCanvasView 同构）。 */
function Harness({ focused }: { focused: number | null }) {
  const [state, setState] = useState(graph)
  const displayNodes = useMemo(
    () => applyEpisodeFocus(state.nodes, state.edges, focused),
    [state, focused],
  )
  harness = {
    move: (id, x) =>
      setState((s) => ({
        ...s,
        nodes: s.nodes.map((n) =>
          n.id === id ? { ...n, position: { x, y: 0 } } : n,
        ),
      })),
  }
  return (
    <div style={{ width: 800, height: 600 }}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={displayNodes}
          edges={state.edges}
          nodeTypes={nodeTypes}
        />
      </ReactFlowProvider>
    </div>
  )
}

describe('集聚焦下真实 React Flow 节点渲染（issue #273 消费侧证据）', () => {
  it('移动一个非成员：其余压暗节点的组件不重渲染，被移动者与成员按需更新', () => {
    renders.clear()
    render(<Harness focused={1} />)
    const baseline = new Map(renders)
    expect(baseline.size).toBe(6)

    act(() => harness!.move('b1', 999))

    const delta = (id: string) =>
      (renders.get(id) ?? 0) - (baseline.get(id) ?? 0)
    expect(delta('b1')).toBeGreaterThan(0)
    // 未变化非成员：userNode 身份未变 → adoptUserNodes 复用内部节点 → 零重渲染
    expect(delta('b2')).toBe(0)
    expect(delta('s3')).toBe(0)
    expect(delta('sh3')).toBe(0)
    // 未变化成员（投影即输入本身）同样零重渲染
    expect(delta('a1')).toBe(0)
    expect(delta('a2')).toBe(0)
  })
})
