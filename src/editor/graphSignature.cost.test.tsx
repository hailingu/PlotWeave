// @vitest-environment happy-dom
/**
 * 持久化签名的成本基线（issue #272）：以节点 `id` 访问器计数「本次渲染
 * 被序列化的节点数」——签名对节点做剥离浅拷贝（`{...n}` 读取全部自有键）
 * 再 JSON.stringify，每序列化一个节点恰好读一次 id；不做时间断言。
 * 场景：无关重渲染 / 选择 / 拖拽过程帧 / 内容编辑 / 拖拽终帧保存，并守
 * 住置脏语义：完整语义修改置脏，纯会话态不保存，终帧位置落盘。
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedSave } from './useDebouncedSave'
import { graphSignature } from './graphSignature'
import { EMPTY_SETTINGS } from './settings'
import type { ProjectContent } from '../model/content'
import type { CanvasNode } from './nodes/types'

const N = 50

/** 计数节点：每次 `{...n}` 剥离拷贝读一次 id。 */
function countedNode(
  i: number,
  reads: { n: number },
  over: Record<string, unknown> = {},
): CanvasNode {
  const id = `s${i}`
  return {
    get id() {
      reads.n += 1
      return id
    },
    type: 'scene',
    position: { x: i * 10, y: 0 },
    data: { name: `场${i}`, sceneNo: i + 1 },
    ...over,
  } as unknown as CanvasNode
}

function graph(reads: { n: number }): CanvasNode[] {
  return Array.from({ length: N }, (_, i) => countedNode(i, reads))
}

function doc(nodes: CanvasNode[], name = '项目'): ProjectContent {
  return {
    name,
    nodes,
    edges: [{ id: 'e1', source: 's0', target: 's1' }],
    settings: EMPTY_SETTINGS,
    episodeTitles: {},
  }
}

/** 替换第 i 个节点为新对象（React Flow 变化表达：新引用）。 */
function replaceAt(
  nodes: CanvasNode[],
  i: number,
  reads: { n: number },
  over: Record<string, unknown>,
): CanvasNode[] {
  return nodes.map((n, k) => (k === i ? countedNode(i, reads, over) : n))
}

describe('graphSignature 逐项缓存（issue #272）', () => {
  it('同一节点对象重复签名只序列化一次；换对象的节点重新序列化', () => {
    const reads = { n: 0 }
    const nodes = graph(reads)
    const a = graphSignature(nodes, [], EMPTY_SETTINGS)
    expect(reads.n).toBe(N)
    const b = graphSignature(nodes, [], EMPTY_SETTINGS)
    expect(b).toBe(a)
    expect(reads.n).toBe(N)
    const moved = replaceAt(nodes, 3, reads, { position: { x: 999, y: 0 } })
    const c = graphSignature(moved, [], EMPTY_SETTINGS)
    expect(c).not.toBe(a)
    expect(reads.n).toBe(N + 1)
  })

  it('签名字面与逐项无缓存实现一致（同一语义恒得同一字符串）', () => {
    const reads = { n: 0 }
    const nodes = graph(reads)
    const edges = [
      { id: 'e1', source: 's0', target: 's1', selected: true, className: 'x' },
    ]
    const omit = (o: object, keys: string[]) => {
      const rest = { ...o } as Record<string, unknown>
      for (const k of keys) delete rest[k]
      return rest
    }
    const expected = JSON.stringify({
      nodes: nodes.map((n) =>
        omit(n, ['selected', 'dragging', 'measured', 'className']),
      ),
      edges: edges.map((e) => omit(e, ['selected', 'className'])),
      settings: EMPTY_SETTINGS,
    })
    expect(graphSignature(nodes, edges, EMPTY_SETTINGS)).toBe(expected)
  })
})

describe('useDebouncedSave 签名成本基线（issue #272）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('无关重渲染（文档字段引用不变）：零节点序列化', () => {
    const reads = { n: 0 }
    const nodes = graph(reads)
    const onSave = vi.fn()
    const { rerender } = renderHook(
      ({ d }: { d: ProjectContent }) => useDebouncedSave(d, onSave),
      { initialProps: { d: doc(nodes) } },
    )
    expect(reads.n).toBe(N)
    rerender({ d: doc(nodes) })
    rerender({ d: doc(nodes) })
    expect(reads.n).toBe(N)
  })

  it('选择变化（两节点换对象）：只序列化两节点，且不置脏保存', () => {
    const reads = { n: 0 }
    const nodes = graph(reads)
    const onSave = vi.fn()
    const { rerender } = renderHook(
      ({ d }: { d: ProjectContent }) => useDebouncedSave(d, onSave),
      { initialProps: { d: doc(nodes) } },
    )
    const before = reads.n
    const selected = replaceAt(
      replaceAt(nodes, 1, reads, { selected: false }),
      2,
      reads,
      { selected: true },
    )
    rerender({ d: doc(selected) })
    expect(reads.n - before).toBe(2)
    act(() => vi.advanceTimersByTime(2000))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('拖拽过程帧（单节点位置逐帧变化）：每帧只序列化被拖节点；终帧位置落盘', async () => {
    const reads = { n: 0 }
    let nodes = graph(reads)
    const onSave = vi.fn()
    const { rerender } = renderHook(
      ({ d }: { d: ProjectContent }) => useDebouncedSave(d, onSave),
      { initialProps: { d: doc(nodes) } },
    )
    const before = reads.n
    const FRAMES = 20
    for (let f = 1; f <= FRAMES; f += 1) {
      nodes = replaceAt(nodes, 7, reads, {
        position: { x: 70 + f, y: f },
        dragging: true,
      })
      rerender({ d: doc(nodes) })
    }
    // 基线（修复前）为 FRAMES × N = 1000；逐项缓存后每帧 1
    expect(reads.n - before).toBe(FRAMES)
    nodes = replaceAt(nodes, 7, reads, {
      position: { x: 70 + FRAMES, y: FRAMES },
    })
    rerender({ d: doc(nodes) })
    await act(async () => {
      vi.advanceTimersByTime(700)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    const saved = onSave.mock.calls[0]![0] as ProjectContent
    expect(saved.nodes[7]!.position).toEqual({ x: 70 + FRAMES, y: FRAMES })
  })

  it('内容编辑（单节点 data 变化）：序列化一节点并置脏保存', async () => {
    const reads = { n: 0 }
    const nodes = graph(reads)
    const onSave = vi.fn()
    const { rerender } = renderHook(
      ({ d }: { d: ProjectContent }) => useDebouncedSave(d, onSave),
      { initialProps: { d: doc(nodes) } },
    )
    const before = reads.n
    const edited = replaceAt(nodes, 5, reads, {
      data: { name: '改名', sceneNo: 6 },
    })
    rerender({ d: doc(edited) })
    expect(reads.n - before).toBe(1)
    await act(async () => {
      vi.advanceTimersByTime(700)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})
