/**
 * 自动排布布局纯函数（issue #94）：把画布节点整理为「主剧情流从左至右
 * 分层、分支同层纵向展开、分镜卡宿主下挂、不连通子图分区」的确定性布局。
 * 只计算位置，不改节点/边内容；调用方（useAutoLayout）负责应用、撤销与
 * 错误反馈。不依赖 React 与 React Flow 运行态，可独立单测。
 *
 * 算法（Sugiyama 简化版）：按 edgeKindOf 分离 attach 边后，剧情流
 * （sequence/branch）做连通分量 → 最长路径分层（迭代松弛，环安全）→
 * 层内按前驱重心排序减交叉 → 每层等 x 纵向堆叠；下挂分镜行在宿主下方
 * 左对齐展开，宿主的有效宽高把分镜行计入层堆叠，保证任意两卡片不重叠。
 */
import type { XYPosition } from '@xyflow/react'
import { compareCodeUnits } from '../compare'
import { edgeKindOf } from './graphRules'
import type { CanvasNode } from './nodes/types'

/** 最小边形状：兼容 React Flow Edge 与测试的简化边。 */
export interface LayoutEdge {
  id: string
  source: string
  target: string
  // xyflow Edge 库形状适配（issue #231）：库类型可选成员显式含
  // undefined，本地边形状参数同款声明以保持接受库值
  sourceHandle?: string | null | undefined
  className?: string | undefined
  type?: string | undefined
}

/** 节点包围盒尺寸（像素）。 */
export interface LayoutSize {
  width: number
  height: number
}

/**
 * 各节点类型的回退尺寸：measured 与顶层 width/height 均缺省时保证整图可算。
 * 宽度为 nodes.css 的**外宽**（content-box 声明宽 + padding + border，如
 * .pw-shot 300 + 28 = 328、.pw-branch 320 + 28 + 3 = 351），按内容宽排布
 * 会让未测量卡片重叠（PR #111 评审）；高度随内容伸缩，只能估值的保持估值。
 */
export const FALLBACK_SIZES: Record<string, LayoutSize> = {
  scene: { width: 340, height: 220 },
  dialogue: { width: 360, height: 240 },
  beat: { width: 220, height: 64 },
  branch: { width: 351, height: 200 },
  shot: { width: 328, height: 260 },
  image: { width: 328, height: 380 },
}
const DEFAULT_SIZE: LayoutSize = { width: 300, height: 200 }

/** 层间横向 / 层内纵向 / 宿主与分镜行 / 分区（连通分量）间距。 */
const H_GAP = 120
const V_GAP = 80
const ATTACH_GAP = 48
const BAND_GAP = 140
/** 同宿主分镜行的卡间距。 */
const SHOT_GAP = 24

/** 首个正数尺寸值（0/负值/缺省视为未提供）。 */
const positiveSize = (v?: number): number | undefined =>
  typeof v === 'number' && v > 0 ? v : undefined

/**
 * 节点是否具备可用于布局的尺寸：measured 或顶层 width/height（fromStoryNode
 * 还原的落盘 layout.size）任一来源能解析出正数宽与高。宽高任一维只能落入
 * 类型回退时（如 .pw-beat 为 max-content，宽度随用户文本无上界），调用方应
 * 等待测量完成而非提交可能重叠的布局（PR #111 评审）。
 */
export function hasUsableSize(node: CanvasNode): boolean {
  const runtime = node as {
    measured?: { width?: number; height?: number }
    width?: number
    height?: number
  }
  const width =
    positiveSize(runtime.measured?.width) ?? positiveSize(runtime.width)
  const height =
    positiveSize(runtime.measured?.height) ?? positiveSize(runtime.height)
  return width !== undefined && height !== undefined
}

/**
 * 节点尺寸取值顺序：measured（React Flow 已测量）→ 顶层 width/height
 * （fromStoryNode 把落盘 layout.size 还原为测量前初始尺寸，PR #111 评审）
 * → 类型回退。跳过前两层任一层都会在不重叠布局中使用偏小的尺寸。
 */
const sizeOf = (node: CanvasNode): LayoutSize => {
  const runtime = node as {
    measured?: { width?: number; height?: number }
    width?: number
    height?: number
  }
  const fallback = FALLBACK_SIZES[node.type] ?? DEFAULT_SIZE
  return {
    width:
      positiveSize(runtime.measured?.width) ??
      positiveSize(runtime.width) ??
      fallback.width,
    height:
      positiveSize(runtime.measured?.height) ??
      positiveSize(runtime.height) ??
      fallback.height,
  }
}

/** 附加在宿主场景下方的分镜行尺寸；无下挂为 null。 */
function shotRowOf(
  sceneId: string,
  shotsByHost: Map<string, CanvasNode[]>,
  sizes: Map<string, LayoutSize>,
): LayoutSize | null {
  const shots = shotsByHost.get(sceneId)
  if (!shots || shots.length === 0) return null
  return {
    width:
      shots.reduce((sum, s) => sum + sizes.get(s.id)!.width, 0) +
      SHOT_GAP * (shots.length - 1),
    height: Math.max(...shots.map((s) => sizes.get(s.id)!.height)),
  }
}

/** 场景有效尺寸：下挂行计入堆叠空间，保证分镜行不与相邻卡片重叠。 */
function effectiveSize(
  node: CanvasNode,
  sizes: Map<string, LayoutSize>,
  rows: Map<string, LayoutSize | null>,
): LayoutSize {
  const base = sizes.get(node.id)!
  const row = rows.get(node.id)
  if (node.type !== 'scene' || !row) return base
  return {
    width: Math.max(base.width, row.width),
    height: base.height + ATTACH_GAP + row.height,
  }
}

/** attach 边归类：目标分镜 → 首个宿主（重复下挂为脏数据，按边 id 取稳定首个）。 */
function classifyAttach(
  edges: LayoutEdge[],
  nodeById: Map<string, CanvasNode>,
): Map<string, string> {
  const hostOf = new Map<string, string>()
  const ordered = [...edges]
  ordered.sort((a, b) => compareCodeUnits(a.id, b.id))
  for (const e of ordered) {
    if (edgeKindOf(e) !== 'attach') continue
    if (
      hostOf.has(e.target) ||
      !nodeById.has(e.source) ||
      !nodeById.has(e.target)
    )
      continue
    hostOf.set(e.target, e.source)
  }
  return hostOf
}

/** 剧情流图：剥离 attach 与端点缺失的边，产出有序节点与出入邻接表。 */
function flowGraph(
  nodes: CanvasNode[],
  edges: LayoutEdge[],
  attached: Set<string>,
) {
  const flowNodes = nodes.filter((n) => !attached.has(n.id))
  const ids = flowNodes.map((n) => n.id).sort(compareCodeUnits)
  const inSet = new Set(ids)
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]))
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const e of edges) {
    if (
      edgeKindOf(e) === 'attach' ||
      !inSet.has(e.source) ||
      !inSet.has(e.target) ||
      e.source === e.target
    )
      continue
    succs.get(e.source)!.push(e.target)
    preds.get(e.target)!.push(e.source)
  }
  return { ids, preds, succs }
}

/** 连通分量（无向：沿出边与入边双向扩散，汇合节点不拆分）：成员排序保确定性。 */
function connectedComponents(
  ids: string[],
  succs: Map<string, string[]>,
  preds: Map<string, string[]>,
): string[][] {
  const seen = new Set<string>()
  const components: string[][] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    const component: string[] = []
    const stack = [id]
    seen.add(id)
    while (stack.length > 0) {
      const cur = stack.pop()!
      component.push(cur)
      const neighbors = [...(succs.get(cur) ?? []), ...(preds.get(cur) ?? [])]
      for (const next of neighbors) {
        if (!seen.has(next)) {
          seen.add(next)
          stack.push(next)
        }
      }
    }
    component.sort(compareCodeUnits)
    components.push(component)
  }
  return components
}

/**
 * 最长路径分层（迭代松弛）：DAG 在 ≤ 节点数轮内收敛到最长路径层；
 * 脏数据成环时不收敛也按轮数上限终止，层级有界且确定（按 id 序松弛）。
 */
function assignLayers(
  ids: string[],
  preds: Map<string, string[]>,
): Map<string, number> {
  const layer = new Map(ids.map((id) => [id, 0]))
  let round = ids.length
  while (round-- > 0) {
    let changed = false
    for (const id of ids) {
      let max = -1
      for (const p of preds.get(id) ?? [])
        max = Math.max(max, layer.get(p) ?? 0)
      if (max >= 0 && max + 1 > layer.get(id)!) {
        layer.set(id, max + 1)
        changed = true
      }
    }
    if (!changed) break
  }
  return layer
}

/** 层内排序：初始按原位置，再按前驱在各层当前序中的重心做两轮减交叉。 */
function orderLayers(
  layers: number,
  grouped: string[][],
  preds: Map<string, string[]>,
  origin: Map<string, XYPosition>,
): string[][] {
  const indexOf = new Map<string, number>()
  for (const group of grouped) group.forEach((id, i) => indexOf.set(id, i))
  for (let pass = 0; pass < 2; pass++) {
    for (let l = 1; l < layers; l++) {
      const bary = (id: string) => {
        const parents = preds.get(id) ?? []
        if (parents.length === 0) return indexOf.get(id) ?? 0
        return (
          parents.reduce((sum, p) => sum + (indexOf.get(p) ?? 0), 0) /
          parents.length
        )
      }
      const layer = grouped[l]
      // 层下标由 layers = grouped.length 守卫；防御性跳过不改变排序结果
      if (layer === undefined) continue
      const ordered = [...layer]
      ordered.sort((a, b) => {
        const diff = bary(a) - bary(b)
        if (diff !== 0) return diff
        const originDiff = originYX(origin, a) - originYX(origin, b)
        if (originDiff !== 0) return originDiff
        return compareCodeUnits(a, b)
      })
      grouped[l] = ordered
      ordered.forEach((id, i) => indexOf.set(id, i))
    }
  }
  return grouped
}

const originYX = (origin: Map<string, XYPosition>, id: string) => {
  const p = origin.get(id)
  return p ? p.y * 100000 + p.x : 0
}

/** 每层统一 x、层内纵向堆叠：返回相对坐标与分量包围盒。 */
function placeLayers(
  grouped: string[][],
  sizes: Map<string, LayoutSize>,
): { pos: Map<string, XYPosition>; boxH: number } {
  const pos = new Map<string, XYPosition>()
  let x = 0
  let boxH = 0
  for (const group of grouped) {
    let y = 0
    let layerW = 0
    for (const id of group) {
      const size = sizes.get(id)!
      pos.set(id, { x, y })
      y += size.height + V_GAP
      layerW = Math.max(layerW, size.width)
    }
    boxH = Math.max(boxH, Math.max(0, y - V_GAP))
    x += layerW + H_GAP
  }
  return { pos, boxH }
}

interface ComponentLayout {
  pos: Map<string, XYPosition>
  boxH: number
  /** 分区排序键：成员最小原 y / x / id。 */
  key: { minY: number; minX: number; minId: string }
}

/** 单连通分量的分层布局（含层内排序与坐标指派）。 */
function layoutComponent(
  members: string[],
  preds: Map<string, string[]>,
  origin: Map<string, XYPosition>,
  sizes: Map<string, LayoutSize>,
): ComponentLayout {
  const layerOf = assignLayers(members, preds)
  const maxLayer = Math.max(0, ...layerOf.values())
  const grouped: string[][] = Array.from({ length: maxLayer + 1 }, () => [])
  // 层值由 assignLayers 限界（≤ maxLayer = grouped.length - 1）；?. 消解
  // 索引读取的缺失分支（issue #230），不可达
  for (const id of members) grouped[layerOf.get(id)!]?.push(id)
  for (const group of grouped) {
    // origin 对每个节点 id 都有值（computeAutoLayout 以全量节点构建，
    // members ⊆ 节点 id）：非空断言即 Map 完整性不变量的表达（issue #165
    // 评审基线：XYPosition 本就是 {x,y}，不再叠双重断言逃逸类型）
    group.sort((a, b) => {
      const pa = origin.get(a)!
      const pb = origin.get(b)!
      return pa.y - pb.y || pa.x - pb.x || (a < b ? -1 : 1)
    })
  }
  const ordered = orderLayers(maxLayer + 1, grouped, preds, origin)
  const { pos, boxH } = placeLayers(ordered, sizes)
  const key = members.reduce(
    (acc, id) => {
      const p = origin.get(id)!
      return {
        minY: Math.min(acc.minY, p.y),
        minX: Math.min(acc.minX, p.x),
        minId: acc.minId < id ? acc.minId : id,
      }
    },
    // 首元素初值兜底只消解下标读取的缺失分支（issue #230）：空成员集
    // 时 reduce 体不执行，key.minId 为 '' 且不可达比较路径
    { minY: Infinity, minX: Infinity, minId: members[0] ?? '' },
  )
  return { pos, boxH, key }
}

/**
 * 计算整图自动排布：返回每个节点的新位置。输入不变性由调用方保证
 * （节点/边原样传入）；结果对相同图确定性一致。任何异常向上抛出，
 * 由调用方兜底为「保留原布局 + 可读反馈」。
 */
export function computeAutoLayout(
  nodes: CanvasNode[],
  edges: LayoutEdge[],
): Map<string, XYPosition> {
  const result = new Map<string, XYPosition>()
  if (nodes.length === 0) return result
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const sizes = new Map(nodes.map((n) => [n.id, sizeOf(n)]))
  const origin = new Map(nodes.map((n) => [n.id, n.position]))
  const hostOf = classifyAttach(edges, nodeById)
  const shotsByHost = new Map<string, CanvasNode[]>()
  const hostEntries = [...hostOf]
  hostEntries.sort((a, b) => compareCodeUnits(a[0], b[0]))
  for (const [shotId, hostId] of hostEntries) {
    const list = shotsByHost.get(hostId) ?? []
    list.push(nodeById.get(shotId)!)
    shotsByHost.set(hostId, list)
  }
  for (const shots of shotsByHost.values()) {
    shots.sort(
      (a, b) => shotNoOf(a) - shotNoOf(b) || compareCodeUnits(a.id, b.id),
    )
  }
  const rows = new Map(
    nodes.map((n) => [
      n.id,
      n.type === 'scene' ? shotRowOf(n.id, shotsByHost, sizes) : null,
    ]),
  )
  const effSizes = new Map(
    nodes.map((n) => [n.id, effectiveSize(n, sizes, rows)]),
  )
  const { ids, preds, succs } = flowGraph(nodes, edges, new Set(hostOf.keys()))

  const components = connectedComponents(ids, succs, preds).map((members) =>
    layoutComponent(members, preds, origin, effSizes),
  )
  components.sort(
    (a, b) =>
      a.key.minY - b.key.minY ||
      a.key.minX - b.key.minX ||
      compareCodeUnits(a.key.minId, b.key.minId),
  )
  let bandY = 0
  for (const component of components) {
    for (const [id, p] of component.pos)
      result.set(id, { x: p.x, y: p.y + bandY })
    bandY += component.boxH + BAND_GAP
  }

  // 下挂分镜行：宿主绝对位置（含分区偏移）下方左对齐展开
  for (const [hostId, shots] of shotsByHost) {
    const host = result.get(hostId)
    if (!host) continue
    const base = sizes.get(hostId)!
    let shotX = host.x
    const shotY = host.y + base.height + ATTACH_GAP
    for (const shot of shots) {
      result.set(shot.id, { x: shotX, y: shotY })
      shotX += sizes.get(shot.id)!.width + SHOT_GAP
    }
  }
  return result
}

const shotNoOf = (node: CanvasNode): number =>
  node.type === 'shot' ? ((node.data as { shotNo?: number }).shotNo ?? 0) : 0
