/**
 * convert 测试族的共享夹具：固定时钟与覆盖五类节点 + 三种边 + 设定集 +
 * 视口的完整会话文档，供 convert*.test.ts 各契约分文件共用。
 */
import type { Edge } from '@xyflow/react'
import type { CanvasNode } from '../editor/nodes/types'
import type { ProjectContent } from './content'

/** 断言用固定时钟：序列化盖戳的可重复基线（不取真实当前时刻）。 */
export const NOW = new Date('2026-08-28T12:00:00.000Z')

/** 完整会话文档的五类样例节点：scene（s1，携带运行态字段与可选布局/
 * 分集字段）/ beat（b1）/ dialogue（d1）/ branch（br1，双选项）/ shot（sh1）。 */
function mkSampleNodes(): CanvasNode[] {
  return [
    {
      id: 's1',
      type: 'scene',
      position: { x: 10, y: 20 },
      selected: true,
      className: 'pw-node-dim',
      data: {
        name: '天台夜话',
        sceneNo: 3,
        interior: false,
        locationId: 'loc-1',
        time: '夜',
        weather: '雨',
        synopsis: '摊牌',
        characterIds: ['ch-1'],
        episodeNo: 2,
      },
    } as unknown as CanvasNode,
    {
      id: 'b1',
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '转折', tone: '压抑', episodeNo: 2 },
    } as unknown as CanvasNode,
    {
      id: 'd1',
      type: 'dialogue',
      position: { x: 0, y: 0 },
      data: {
        name: '对白',
        lines: [{ id: 'line-1', kind: 'line', text: '别走', speaker: 'ch-1', side: 'left', vo: false }],
      },
    } as unknown as CanvasNode,
    {
      id: 'br1',
      type: 'branch',
      position: { x: 0, y: 0 },
      data: {
        prompt: '女主是否发现真相',
        options: [
          { id: 'opt-1', label: '坦白' },
          { id: 'opt-2', label: '隐瞒' },
        ],
        episodeNo: 2,
      },
    } as unknown as CanvasNode,
    {
      id: 'sh1',
      type: 'shot',
      position: { x: 0, y: 0 },
      data: {
        shotNo: 1,
        size: '特写',
        picture: '雨夜车窗',
        prompt: ' cinematic rain ',
        refs: [{ id: 'ref-1', kind: 'character', label: '林晚' }],
      },
    } as unknown as CanvasNode,
  ]
}

/** 三种边形态的样例：sequence（e1）/ branch（e2，绑定 opt-2 选项）/
 * attach（e3，scene → shot）。 */
function mkSampleEdges(): Edge[] {
  return [
    { id: 'e1', source: 's1', target: 'd1', className: 'pw-edge-sequence', selected: true } as Edge,
    {
      id: 'e2',
      source: 'br1',
      sourceHandle: 'option-opt-2',
      target: 'd1',
      type: 'branch',
    } as Edge,
    { id: 'e3', source: 's1', sourceHandle: 'shots', target: 'sh1', className: 'pw-edge-attach' } as Edge,
  ]
}

/** 覆盖五类节点 + 三种边 + 设定集 + 视口的完整会话文档。 */
export function mkContent(): ProjectContent {
  return {
    name: '午夜出租车',
    createdAt: '2026-08-01T00:00:00.000Z',
    nodes: mkSampleNodes(),
    edges: mkSampleEdges(),
    settings: {
      characters: [{ id: 'ch-1', name: '林晚', gradient: 'g-lin', bio: '女主' }],
      locations: [{ id: 'loc-1', name: '天台', note: '雨夜' }],
    },
    episodeTitles: { 2: '摊牌' },
    viewport: { x: 100, y: -40, zoom: 1.25 },
  }
}
