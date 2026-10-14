import type { Edge } from '@xyflow/react'
import { avatarGradientOf, type ProjectSettings } from '../settings'
import type { CanvasNode } from '../nodes/types'
import { SCENE_SHOT_HANDLE, branchOptionHandle } from '../graphRules'
import type { DemoGraph } from './demoGraph'

/**
 * M15 固定规模性能夹具（docs/swiftui-react-flow-migration-plan.md §7.2，
 * issue #523）：确定性、脱敏的合成短剧图，供脚本化持续操作测量帧时间与
 * 内存。全部内容为编号虚构文案，只在内存中存在，不经任何持久化通道；
 * 图结构由 canvasPerfFixture.test.ts 用交互连线同一套 graphRules 校验。
 */

/** 登记的测量规模：常用 100/500，压力 1000（§7.2 定稿规格）。 */
export const CANVAS_PERF_SCALES = [100, 500, 1000] as const

/** 测量规模类型：未登记规模的 hash 一律拒绝进入夹具。 */
export type CanvasPerfScale = (typeof CANVAS_PERF_SCALES)[number]

/** 图片节点统一声明的合成分辨率；不携带真实媒体字节（outputs 恒空）。 */
export const CANVAS_PERF_IMAGE_RESOLUTION = '1024x1024'

/** 验证页徽标里的夹具口径文案，与 9 节点演示夹具区分。 */
export const CANVAS_PERF_LABEL = '性能夹具'

/** 每个故事单元的节点数；规模必须能被它整除，比例才可预告。 */
const UNIT_NODE_COUNT = 10

/** 单元内各列的 x 坐标：主行走廊 8 列，分镜/图片挂在下方副行。 */
const COLUMN_X = [0, 300, 600, 900, 1200, 1500, 1800, 2100] as const

/** 主行与副行的 y 偏移；副行承载 attach 分镜与自由图片节点。 */
const ROW_Y = { main: 0, attach: 300 } as const

/** 单元占位尺寸：宽按最深列、高按副行计算，供网格摆放。 */
const UNIT_WIDTH = 2400
const UNIT_HEIGHT = 560

/** 固定设定集：4 个虚构角色、2 个虚构地点，按单元序号轮转引用。 */
const SETTINGS: ProjectSettings = {
  characters: [
    {
      id: 'perf-ch-a',
      name: '性能夹具角色甲',
      gradient: avatarGradientOf('perf-ch-a'),
      bio: '虚构合成角色：仅用于规模测量。',
    },
    {
      id: 'perf-ch-b',
      name: '性能夹具角色乙',
      gradient: avatarGradientOf('perf-ch-b'),
      bio: '虚构合成角色：仅用于规模测量。',
    },
    {
      id: 'perf-ch-c',
      name: '性能夹具角色丙',
      gradient: avatarGradientOf('perf-ch-c'),
      bio: '虚构合成角色：仅用于规模测量。',
    },
    {
      id: 'perf-ch-d',
      name: '性能夹具角色丁',
      gradient: avatarGradientOf('perf-ch-d'),
      bio: '虚构合成角色：仅用于规模测量。',
    },
  ],
  locations: [
    { id: 'perf-loc-a', name: '夹具地点甲' },
    { id: 'perf-loc-b', name: '夹具地点乙' },
  ],
}

/** 单元内节点的列/行与家族蓝图；顺序即全局节点顺序。 */
const UNIT_PLAN = [
  { key: 'b0', type: 'beat', column: 0, row: 'main' },
  { key: 's1', type: 'scene', column: 1, row: 'main' },
  { key: 'd1', type: 'dialogue', column: 2, row: 'main' },
  { key: 'br', type: 'branch', column: 3, row: 'main' },
  { key: 'ba', type: 'beat', column: 4, row: 'main' },
  { key: 'bb', type: 'beat', column: 5, row: 'main' },
  { key: 's2', type: 'scene', column: 6, row: 'main' },
  { key: 'd2', type: 'dialogue', column: 7, row: 'main' },
  { key: 'sh', type: 'shot', column: 5, row: 'attach' },
  { key: 'im', type: 'image', column: 2, row: 'attach' },
] as const

/** 每单元的内部连线（桥接边由装配阶段补）：8 条，见 UNIT_EDGES 文案。 */
interface UnitEdgePlan {
  from: string
  to: string
  kind: 'sequence' | 'branch-a' | 'branch-b' | 'attach'
}

const UNIT_EDGES: readonly UnitEdgePlan[] = [
  { from: 'b0', to: 's1', kind: 'sequence' },
  { from: 's1', to: 'd1', kind: 'sequence' },
  { from: 'd1', to: 'br', kind: 'sequence' },
  { from: 'br', to: 'ba', kind: 'branch-a' },
  { from: 'br', to: 'bb', kind: 'branch-b' },
  { from: 'bb', to: 's2', kind: 'sequence' },
  { from: 's2', to: 'd2', kind: 'sequence' },
  { from: 's2', to: 'sh', kind: 'attach' },
]

/** 单元产出的节点/边集合；id 前缀由调用方注入规模与单元号。 */
interface UnitArtifact {
  nodes: CanvasNode[]
  edges: Edge[]
}

/** 单元内共享的身份与文案锚点；id 前缀与选项句柄同源。 */
interface UnitNodeContext {
  readonly prefix: string
  readonly tag: string
}

/** 节拍节点：b0/ba/bb 三个槽位共用同一数据形状。 */
function beatNode(
  context: UnitNodeContext,
  key: string,
  position: { x: number; y: number },
  suffix: string,
  tone: string,
): CanvasNode {
  return {
    id: `${context.prefix}-${key}`,
    type: 'beat',
    position,
    data: { name: `性能节拍 ${context.tag}-${suffix}`, tone },
  }
}

/** 场景节点：内外景/地点/时间按单元奇偶轮换，两组角色交替在场。 */
function sceneNode(
  context: UnitNodeContext,
  key: string,
  position: { x: number; y: number },
  slot: number,
  sceneNo: number,
  unit: number,
): CanvasNode {
  const interior = (unit + slot) % 2 === 0
  return {
    id: `${context.prefix}-${key}`,
    type: 'scene',
    position,
    data: {
      name: `性能场景 ${context.tag}-${slot}`,
      sceneNo: sceneNo + slot - 1,
      interior,
      locationId: interior ? 'perf-loc-a' : 'perf-loc-b',
      time: interior ? '日' : '夜',
      synopsis: `合成场景描述 ${context.tag}-${slot}，仅用于规模测量。`,
      characterIds:
        slot === 1 ? ['perf-ch-a', 'perf-ch-b'] : ['perf-ch-c', 'perf-ch-d'],
    },
  }
}

/** 对白节点：台词/动作/台词三行，说话人按槽位轮换。 */
function dialogueNode(
  context: UnitNodeContext,
  key: string,
  position: { x: number; y: number },
  slot: number,
): CanvasNode {
  const speakers: [string, string] =
    slot === 1 ? ['perf-ch-a', 'perf-ch-b'] : ['perf-ch-c', 'perf-ch-d']
  const lineKey = `${key}-l`
  return {
    id: `${context.prefix}-${key}`,
    type: 'dialogue',
    position,
    data: {
      name: `性能对白 ${context.tag}-${slot}`,
      lines: [
        {
          id: `perf-${context.tag}-${lineKey}1`,
          kind: 'line',
          text: `合成台词 ${context.tag}-${slot}A。`,
          speaker: speakers[0],
          side: 'left',
        },
        {
          id: `perf-${context.tag}-${lineKey}2`,
          kind: 'action',
          text: `合成动作 ${context.tag}-${slot}。`,
        },
        {
          id: `perf-${context.tag}-${lineKey}3`,
          kind: 'line',
          text: `合成台词 ${context.tag}-${slot}B。`,
          speaker: speakers[1],
          side: 'right',
        },
      ],
    },
  }
}

/** 分支节点：选项 id 必须与 buildUnit 里 branch 边的 branchOptionHandle
 * 同源，否则真实 React Flow 找不到出口端口、选项边不渲染。 */
function branchNode(
  context: UnitNodeContext,
  position: { x: number; y: number },
): CanvasNode {
  return {
    id: `${context.prefix}-br`,
    type: 'branch',
    position,
    data: {
      prompt: `性能分支 ${context.tag}？`,
      options: [
        { id: `${context.prefix}-opt-a`, label: 'A 线' },
        { id: `${context.prefix}-opt-b`, label: 'B 线' },
      ],
    },
  }
}

/** 分镜卡节点：监视器卡形状，引用一个合成角色参考。 */
function shotNode(
  context: UnitNodeContext,
  position: { x: number; y: number },
  shotNo: number,
): CanvasNode {
  return {
    id: `${context.prefix}-sh`,
    type: 'shot',
    position,
    data: {
      shotNo,
      size: '中景',
      picture: `合成画面描述 ${context.tag}，仅用于规模测量。`,
      prompt: `synthetic perf fixture shot ${context.tag}`,
      refs: [
        {
          id: `perf-${context.tag}-ref`,
          kind: 'character',
          label: `性能夹具角色参考 ${context.tag}`,
        },
      ],
    },
  }
}

/** 图片节点：声明固定分辨率但不携带媒体字节（outputs 恒空）。 */
function imageNode(
  context: UnitNodeContext,
  position: { x: number; y: number },
): CanvasNode {
  return {
    id: `${context.prefix}-im`,
    type: 'image',
    position,
    data: {
      prompt: `性能图片占位 ${context.tag}（不触发生成）`,
      model: 'perf:placeholder',
      size: CANVAS_PERF_IMAGE_RESOLUTION,
      outputs: {},
    },
  }
}

/** 单元内节点构造分派：编号合成文案，字段形状与 demoGraph 对齐。 */
function unitNode(
  scale: CanvasPerfScale,
  unit: number,
  key: (typeof UNIT_PLAN)[number]['key'],
  position: { x: number; y: number },
  sceneNo: number,
  shotNo: number,
): CanvasNode {
  const context: UnitNodeContext = {
    prefix: `perf-s${scale}-u${unit}`,
    tag: `S${scale}-U${unit}`,
  }
  switch (key) {
    case 'b0':
      return beatNode(context, key, position, '入口', '基准')
    case 'ba':
      return beatNode(context, key, position, 'A', '基准')
    case 'bb':
      return beatNode(context, key, position, 'B', '压力')
    case 's1':
      return sceneNode(context, key, position, 1, sceneNo, unit)
    case 's2':
      return sceneNode(context, key, position, 2, sceneNo, unit)
    case 'd1':
      return dialogueNode(context, key, position, 1)
    case 'd2':
      return dialogueNode(context, key, position, 2)
    case 'br':
      return branchNode(context, position)
    case 'sh':
      return shotNode(context, position, shotNo)
    case 'im':
      return imageNode(context, position)
  }
}

/** 构造一个故事单元；桥接边（上一单元 d2 → 本单元 b0）由调用方补。 */
function buildUnit(scale: CanvasPerfScale, unit: number): UnitArtifact {
  const prefix = `perf-s${scale}-u${unit}`
  const sceneNo = unit * 2 + 1
  const shotNo = unit + 1
  const perRow = Math.min(10, Math.max(4, Math.round(Math.sqrt(scale / 10))))
  const row = Math.floor(unit / perRow)
  const column = unit % perRow
  const baseX = column * UNIT_WIDTH + row * 120
  const baseY = row * UNIT_HEIGHT

  const nodes: CanvasNode[] = UNIT_PLAN.map((plan) =>
    unitNode(
      scale,
      unit,
      plan.key,
      {
        x: baseX + (COLUMN_X[plan.column] ?? 0),
        y: baseY + (plan.row === 'main' ? ROW_Y.main : ROW_Y.attach),
      },
      sceneNo,
      shotNo,
    ),
  )

  const edges: Edge[] = UNIT_EDGES.map((plan, index) => {
    const base = {
      id: `${prefix}-e${index}`,
      source: `${prefix}-${plan.from}`,
      target: `${prefix}-${plan.to}`,
    }
    if (plan.kind === 'sequence') {
      return { ...base, className: 'pw-edge-sequence' }
    }
    if (plan.kind === 'attach') {
      return {
        ...base,
        sourceHandle: SCENE_SHOT_HANDLE,
        className: 'pw-edge-attach',
      }
    }
    const option = plan.kind === 'branch-a' ? 'a' : 'b'
    return {
      ...base,
      sourceHandle: branchOptionHandle(`${prefix}-opt-${option}`),
      type: 'branch',
    }
  })

  return { nodes, edges }
}

/** 构造固定规模的性能夹具图；确定性纯函数，每次调用产出全新对象。 */
export function canvasPerfFixture(scale: CanvasPerfScale): DemoGraph {
  const units = scale / UNIT_NODE_COUNT
  const nodes: CanvasNode[] = []
  const edges: Edge[] = []
  for (let unit = 0; unit < units; unit += 1) {
    const artifact = buildUnit(scale, unit)
    if (unit > 0) {
      edges.push({
        id: `perf-s${scale}-bridge-${unit}`,
        source: `perf-s${scale}-u${unit - 1}-d2`,
        target: `perf-s${scale}-u${unit}-b0`,
        className: 'pw-edge-sequence',
      })
    }
    nodes.push(...artifact.nodes)
    edges.push(...artifact.edges)
  }
  return { settings: SETTINGS, nodes, edges }
}

/** 解析验证页 hash（#perf:100 等）；未登记规模或格式不符返回 null。 */
export function parseCanvasPerfHash(hash: string): CanvasPerfScale | null {
  const match = /^#perf:(\d+)$/.exec(hash)
  if (!match) return null
  const value = Number(match[1])
  return (CANVAS_PERF_SCALES as readonly number[]).includes(value)
    ? (value as CanvasPerfScale)
    : null
}
