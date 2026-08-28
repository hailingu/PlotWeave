import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { stripEdge, stripNode } from './persist'
import type { CanvasNode } from './nodes/types'

describe('persist（落盘序列化剥离 React Flow 运行态）', () => {
  it('stripNode 只保留 id/type/position/data，丢弃 selected/className 等运行态', () => {
    const node = {
      id: 's1',
      type: 'scene',
      position: { x: 10, y: 20 },
      data: { name: '场', sceneNo: 1 },
      selected: true,
      className: 'pw-node-dim',
      dragging: false,
      measured: { width: 200, height: 100 },
    } as unknown as CanvasNode
    expect(stripNode(node)).toEqual({
      id: 's1',
      type: 'scene',
      position: { x: 10, y: 20 },
      data: { name: '场', sceneNo: 1 },
    })
  })

  it('stripEdge 条件携带端口/类型/样式/数据，丢弃选中态', () => {
    const bare: Edge = { id: 'e1', source: 'a', target: 'b', selected: true }
    expect(stripEdge(bare)).toEqual({ id: 'e1', source: 'a', target: 'b' })

    const full: Edge = {
      id: 'e2',
      source: 'a',
      target: 'b',
      sourceHandle: 'option-0',
      type: 'branch',
      className: 'pw-edge-sequence',
      data: { optionLabel: '选项 A' },
      selected: true,
    }
    expect(stripEdge(full)).toEqual({
      id: 'e2',
      source: 'a',
      target: 'b',
      sourceHandle: 'option-0',
      type: 'branch',
      className: 'pw-edge-sequence',
      data: { optionLabel: '选项 A' },
    })
  })
})
