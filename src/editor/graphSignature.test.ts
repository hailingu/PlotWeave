import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { graphSignature } from './graphSignature'
import { EMPTY_SETTINGS } from './settings'
import type { CanvasNode } from './nodes/types'

const node = (over: Record<string, unknown> = {}) =>
  ({
    id: 's1',
    type: 'scene',
    position: { x: 0, y: 0 },
    data: { name: '场一', sceneNo: 1 },
    ...over,
  }) as unknown as CanvasNode

describe('graphSignature', () => {
  it('剥离会话态与样式类：纯选择/拖拽/测量帧签名不变', () => {
    const plain = graphSignature(
      [node()],
      [{ id: 'e1', source: 'a', target: 'b' } as Edge],
      EMPTY_SETTINGS,
    )
    const sessionOnly = graphSignature(
      [node({ selected: true, dragging: true, measured: { width: 10, height: 10 }, className: 'pw-node-dim' })],
      [{ id: 'e1', source: 'a', target: 'b', selected: true, className: 'pw-edge-sequence' } as Edge],
      EMPTY_SETTINGS,
    )
    expect(sessionOnly).toBe(plain)
  })

  it('语义内容变化即签名变化：执行前快照可用于对账', () => {
    const base = graphSignature([node()], [], EMPTY_SETTINGS)
    expect(graphSignature([node({ data: { name: '场二', sceneNo: 1 } })], [], EMPTY_SETTINGS)).not.toBe(base)
    expect(
      graphSignature([node()], [{ id: 'e1', source: 's1', target: 's2' } as Edge], EMPTY_SETTINGS),
    ).not.toBe(base)
    expect(
      graphSignature([node()], [], {
        characters: [{ id: 'c1', name: '林晚', gradient: 'g1' }],
        locations: [],
      }),
    ).not.toBe(base)
  })
})
