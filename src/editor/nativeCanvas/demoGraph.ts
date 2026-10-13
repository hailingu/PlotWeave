import type { Edge } from '@xyflow/react'
import { avatarGradientOf, type ProjectSettings } from '../settings'
import type { CanvasNode } from '../nodes/types'
import { SCENE_SHOT_HANDLE, branchOptionHandle } from '../graphRules'

/**
 * P1 原生视觉首片的确定性演示夹具（docs/swiftui-react-flow-migration-plan.md
 * §5 第 3 项）：纯虚构、脱敏的短剧片段，覆盖全部注册节点类型与三种连线
 * 语义；只在内存中存在，不经任何持久化通道。图结构由 demoGraph.test.ts
 * 用交互连线同一套 graphRules 校验。
 */

/** 演示标记文案：画布页与测试共用的「内存演示数据」徽标。 */
export const DEMO_GRAPH_LABEL = '内存演示数据'

/** 演示夹具形状：设定集 + 画布节点/连线（React Flow 运行态）。 */
export interface DemoGraph {
  readonly settings: ProjectSettings
  readonly nodes: CanvasNode[]
  readonly edges: Edge[]
}

const SETTINGS: ProjectSettings = {
  characters: [
    {
      id: 'demo-ch-mo',
      name: '陈默',
      gradient: avatarGradientOf('demo-ch-mo'),
      bio: '虚构演示角色：追更这部剧的普通观众。',
    },
    {
      id: 'demo-ch-wan',
      name: '林晚',
      gradient: avatarGradientOf('demo-ch-wan'),
      bio: '虚构演示角色：打算离开的主演。',
    },
    {
      id: 'demo-ch-zhou',
      name: '老周',
      gradient: avatarGradientOf('demo-ch-zhou'),
      bio: '虚构演示角色：茶馆老板。',
    },
  ],
  locations: [
    { id: 'demo-loc-roof', name: '天台' },
    { id: 'demo-loc-tea', name: '茶馆' },
  ],
}

const NODES: CanvasNode[] = [
  {
    id: 'demo-beat-open',
    type: 'beat',
    position: { x: 0, y: 20 },
    data: { name: '节拍 · 开端', tone: '克制' },
  },
  {
    id: 'demo-scene-roof',
    type: 'scene',
    position: { x: 320, y: -20 },
    data: {
      name: '天台对峙',
      sceneNo: 1,
      interior: false,
      locationId: 'demo-loc-roof',
      time: '夜',
      weather: '风',
      synopsis: '陈默在天台拦住收拾行李的林晚，两人把没说完的话说完。',
      characterIds: ['demo-ch-mo', 'demo-ch-wan'],
    },
  },
  {
    id: 'demo-dlg-last',
    type: 'dialogue',
    position: { x: 680, y: 60 },
    data: {
      name: '对白 · 最后一句',
      lines: [
        {
          id: 'demo-line-1',
          kind: 'line',
          text: '你真的要退租这季人生吗？',
          speaker: 'demo-ch-mo',
          side: 'left',
        },
        { id: 'demo-line-2', kind: 'action', text: '风把台词吹散了一半。' },
        {
          id: 'demo-line-3',
          kind: 'line',
          text: '替我看完最后一集。',
          speaker: 'demo-ch-wan',
          side: 'right',
        },
      ],
    },
  },
  {
    id: 'demo-branch-stay',
    type: 'branch',
    position: { x: 1040, y: 20 },
    data: {
      prompt: '林晚会留下吗？',
      options: [
        { id: 'demo-opt-stay', label: '留下' },
        { id: 'demo-opt-go', label: '离开' },
      ],
    },
  },
  {
    id: 'demo-beat-a',
    type: 'beat',
    position: { x: 1400, y: -140 },
    data: { name: '节拍 · A 线 · 留下', tone: '回暖' },
  },
  {
    id: 'demo-beat-b',
    type: 'beat',
    position: { x: 1400, y: 200 },
    data: { name: '节拍 · B 线 · 离开', tone: '怅然' },
  },
  {
    id: 'demo-scene-tea',
    type: 'scene',
    position: { x: 1740, y: -200 },
    data: {
      name: '茶馆收尾',
      sceneNo: 2,
      interior: true,
      locationId: 'demo-loc-tea',
      time: '日',
      synopsis: '老周擦着杯子，把没说完的话留给下一集。',
      characterIds: ['demo-ch-zhou', 'demo-ch-wan'],
    },
  },
  {
    id: 'demo-shot-1',
    type: 'shot',
    position: { x: 700, y: 420 },
    data: {
      shotNo: 1,
      size: '中景',
      picture: '天台护栏前，两人侧影被路灯拉长。',
      prompt: 'night rooftop, two silhouettes, wind, cinematic',
      refs: [{ id: 'demo-ref-1', kind: 'character', label: '陈默 · 侧脸参考' }],
    },
  },
  {
    id: 'demo-image-1',
    type: 'image',
    position: { x: 60, y: 460 },
    data: {
      prompt: '天台夜景概念图（演示，不触发生成）',
      model: 'demo:sketch',
      size: '1024x1024',
      outputs: {},
    },
  },
]

const EDGES: Edge[] = [
  {
    id: 'demo-e-open-roof',
    source: 'demo-beat-open',
    target: 'demo-scene-roof',
    className: 'pw-edge-sequence',
  },
  {
    id: 'demo-e-roof-dlg',
    source: 'demo-scene-roof',
    target: 'demo-dlg-last',
    className: 'pw-edge-sequence',
  },
  {
    id: 'demo-e-dlg-branch',
    source: 'demo-dlg-last',
    target: 'demo-branch-stay',
    className: 'pw-edge-sequence',
  },
  {
    id: 'demo-e-opt-a',
    source: 'demo-branch-stay',
    sourceHandle: branchOptionHandle('demo-opt-stay'),
    target: 'demo-beat-a',
    type: 'branch',
  },
  {
    id: 'demo-e-opt-b',
    source: 'demo-branch-stay',
    sourceHandle: branchOptionHandle('demo-opt-go'),
    target: 'demo-beat-b',
    type: 'branch',
  },
  {
    id: 'demo-e-a-tea',
    source: 'demo-beat-a',
    target: 'demo-scene-tea',
    className: 'pw-edge-sequence',
  },
  {
    id: 'demo-e-roof-shot',
    source: 'demo-scene-roof',
    sourceHandle: SCENE_SHOT_HANDLE,
    target: 'demo-shot-1',
    className: 'pw-edge-attach',
  },
]

/** 返回演示夹具（每次同一份字面量结构的浅拷贝调用结果，确定性不变）。 */
export function demoGraph(): DemoGraph {
  return {
    settings: SETTINGS,
    nodes: NODES,
    edges: EDGES,
  }
}
