/** The actual scene-host lookup must do linear work, independent of wall-clock load. */
import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { hostSceneMap } from './outline'
import { SCENE_SHOT_HANDLE } from './graphRules'
import type { CanvasNode } from './nodes/types'

/** Original node identities remain the lookup result, including duplicate-id precedence. */
function scene(id: string, name = id): CanvasNode {
  return {
    id,
    type: 'scene',
    position: { x: 0, y: 0 },
    data: {
      name,
      sceneNo: 1,
      interior: false,
      time: '',
      synopsis: '',
      characterIds: [],
    },
  }
}

/** Count real node-id reads rather than assuming a particular indexing implementation. */
function countedGraph(nodeCount: number, edgeCount: number) {
  let reads = 0
  const nodes = Array.from({ length: nodeCount }, (_, index) => {
    const id = 'scene-' + index
    const node = scene(id)
    Object.defineProperty(node, 'id', {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1
        return id
      },
    })
    return node
  })
  const edges: Edge[] = Array.from({ length: edgeCount }, (_, index) => ({
    id: 'edge-' + index,
    source: 'scene-' + (index % nodeCount),
    sourceHandle: SCENE_SHOT_HANDLE,
    target: 'shot-' + index,
  }))
  return { nodes, edges, reads: () => reads }
}

describe('linear scene-host lookup', () => {
  it.each([1200, 2400])(
    'bounds actual lookup work for %s nodes and twice as many attachments',
    (count) => {
      const graph = countedGraph(count, count * 2)
      const map = hostSceneMap(graph.nodes, graph.edges)
      const reads = graph.reads()
      expect(map.size).toBe(count * 2)
      expect(map.get('shot-0')).toBe(graph.nodes[0])
      expect(map.get('shot-' + (count * 2 - 1))).toBe(graph.nodes[count - 1])
      expect(reads).toBeLessThanOrEqual(
        8 * (graph.nodes.length + graph.edges.length),
      )
    },
  )

  it('retains first duplicate source identity and last attachment target precedence', () => {
    const first = scene('same', 'first')
    const duplicate = scene('same', 'duplicate')
    const other = scene('other')
    const edges: Edge[] = [
      {
        id: 'a',
        source: 'other',
        target: 'shot',
        sourceHandle: SCENE_SHOT_HANDLE,
      },
      {
        id: 'b',
        source: 'same',
        target: 'shot',
        sourceHandle: SCENE_SHOT_HANDLE,
      },
      {
        id: 'missing',
        source: 'absent',
        target: 'missing',
        sourceHandle: SCENE_SHOT_HANDLE,
      },
      { id: 'sequence', source: 'same', target: 'plain' },
    ]
    const map = hostSceneMap([first, duplicate, other], edges)
    expect([...map.keys()]).toEqual(['shot'])
    expect(map.get('shot')).toBe(first)
  })
})
