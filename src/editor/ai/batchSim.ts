/**
 * AI 批量命令的折叠模拟器（数据模型 §12：Agent 是命令的另一个生产者）。
 * applyAiBatch 拆出的纯逻辑：把一批命令在「虚拟终态」上折叠执行——
 * 批量创建时场号/镜号基线与 ref→id 引用解析都基于模拟数组，
 * 每条命令的前进/回退闭包在模拟期一次性捕获，不做运行期查询。
 * 产出的 forward/backward 闭包列表由调用方整体入栈为一条复合命令。
 */
import { addEdge, type Edge, type XYPosition } from '@xyflow/react'
import { SCENE_SHOT_HANDLE, branchOptionHandle } from '../graphRules'
import type { CreatableType } from '../creatable'
import type { CanvasNode } from '../nodes/types'
import type { AiCommand } from './commands'

/** 模拟器的虚拟终态与闭包收集。 */
interface BatchSim {
  nodes: CanvasNode[]
  edges: Edge[]
  refToId: Map<string, string>
  forward: Array<() => void>
  backward: Array<() => void>
}

/** 节点构建器签名：与 EditorView.buildNewNode 一致（at = 手动创建落点）。 */
export type BuildNewNode = (
  type: CreatableType,
  opts?: {
    at?: XYPosition
    selected?: boolean
    data?: Record<string, unknown>
    against?: CanvasNode[]
  },
) => CanvasNode

/** 模拟器所需的画布写入动作（由 EditorView 注入真实 setState）。 */
export interface BatchOps {
  buildNewNode: BuildNewNode
  applyDataPatch: (id: string, patch: Record<string, unknown>) => void
  setNodes: (updater: (all: CanvasNode[]) => CanvasNode[]) => void
  setEdges: (updater: (eds: Edge[]) => Edge[]) => void
}

const simCreate = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<AiCommand, { op: 'create_node' }>,
): void => {
  const node = ops.buildNewNode(cmd.nodeType as CreatableType, {
    selected: false,
    data: (cmd.data as Record<string, unknown>) ?? undefined,
    against: sim.nodes,
  })
  if (typeof cmd.ref === 'string' && cmd.ref !== '') sim.refToId.set(cmd.ref, node.id)
  sim.nodes = [...sim.nodes, node]
  sim.forward.push(() => ops.setNodes((all) => [...all, node]))
  sim.backward.push(() => ops.setNodes((all) => all.filter((n) => n.id !== node.id)))
}

const simUpdate = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<AiCommand, { op: 'update_node' }>,
): void => {
  const id = sim.refToId.get(cmd.nodeId) ?? cmd.nodeId
  const target = sim.nodes.find((n) => n.id === id)
  if (!target) return
  const before: Record<string, unknown> = {}
  for (const k of Object.keys(cmd.patch)) before[k] = (target.data as Record<string, unknown>)[k]
  sim.nodes = sim.nodes.map((n) =>
    n.id === id ? ({ ...n, data: { ...n.data, ...cmd.patch } } as CanvasNode) : n,
  )
  sim.forward.push(() => ops.applyDataPatch(id, cmd.patch))
  sim.backward.push(() => ops.applyDataPatch(id, before))
}

const simDelete = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<AiCommand, { op: 'delete_node' }>,
): void => {
  const removedId = sim.refToId.get(cmd.nodeId) ?? cmd.nodeId
  const idSet = new Set([removedId])
  const removedNodes = sim.nodes.filter((n) => idSet.has(n.id))
  if (removedNodes.length === 0) return
  const removedEdges = sim.edges.filter((e) => idSet.has(e.source) || idSet.has(e.target))
  sim.nodes = sim.nodes.filter((n) => !idSet.has(n.id))
  sim.edges = sim.edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target))
  // 状态删除内联（不走 deleteNodesByIds——那会额外入栈破坏单步撤销）
  sim.forward.push(() => {
    ops.setNodes((all) => all.filter((n) => n.id !== removedId))
    ops.setEdges((eds) => eds.filter((e) => e.source !== removedId && e.target !== removedId))
  })
  sim.backward.push(() => {
    ops.setNodes((all) => [...all, ...removedNodes])
    ops.setEdges((eds) => [...eds, ...removedEdges])
  })
}

/** connect_edge 的目标边：attach / branch / sequence 三态（§4.4）。 */
const connectEdgeOf = (
  sim: BatchSim,
  cmd: Extract<AiCommand, { op: 'connect_edge' }>,
  srcId: string,
  dstId: string,
): Edge => {
  const kind = typeof cmd.edgeKind === 'string' ? cmd.edgeKind : 'sequence'
  if (kind === 'attach') {
    // 分镜下挂（§4.4 垂直派生边）
    return {
      id: `e-${srcId}-shots-${dstId}-ai-${sim.forward.length}`,
      source: srcId,
      target: dstId,
      sourceHandle: SCENE_SHOT_HANDLE,
      className: 'pw-edge-attach',
    }
  }
  if (kind === 'branch') {
    // 分支选项出口：胶囊文案与分支选项同源（§4.4 不落第二份拷贝语义）
    const idx = typeof cmd.optionIndex === 'number' ? cmd.optionIndex : 0
    const branchNode = sim.nodes.find((n) => n.id === srcId)
    const optionLabel = branchNode?.type === 'branch' ? (branchNode.data.options[idx]?.label ?? '') : ''
    return {
      id: `e-${srcId}-${branchOptionHandle(idx)}-${dstId}-ai-${sim.forward.length}`,
      source: srcId,
      target: dstId,
      sourceHandle: branchOptionHandle(idx),
      type: 'branch',
      data: { optionLabel },
    }
  }
  return {
    id: `e-${srcId}-${dstId}-ai-${sim.forward.length}`,
    source: srcId,
    target: dstId,
    className: 'pw-edge-sequence',
  }
}

const simConnect = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<AiCommand, { op: 'connect_edge' }>,
): void => {
  const srcId = sim.refToId.get(cmd.sourceId) ?? cmd.sourceId
  const dstId = sim.refToId.get(cmd.targetId) ?? cmd.targetId
  const edge = connectEdgeOf(sim, cmd, srcId, dstId)
  sim.edges = [...sim.edges, edge]
  sim.forward.push(() => ops.setEdges((eds) => addEdge(edge, eds)))
  sim.backward.push(() => ops.setEdges((eds) => eds.filter((e) => e.id !== edge.id)))
}

const simDisconnect = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<AiCommand, { op: 'disconnect_edge' }>,
): void => {
  const srcId = sim.refToId.get(cmd.sourceId) ?? cmd.sourceId
  const dstId = sim.refToId.get(cmd.targetId) ?? cmd.targetId
  const hitIdx = sim.edges.findIndex((e) => e.source === srcId && e.target === dstId)
  if (hitIdx < 0) return
  const removed = sim.edges[hitIdx]
  sim.edges = [...sim.edges.slice(0, hitIdx), ...sim.edges.slice(hitIdx + 1)]
  sim.forward.push(() =>
    ops.setEdges((eds) => eds.filter((e) => !(e.source === removed.source && e.target === removed.target))),
  )
  sim.backward.push(() => ops.setEdges((eds) => addEdge(removed, eds)))
}

/** 批次折叠执行的结果：forward 按命令顺序生效；backward 反序回放即整批回滚。 */
export interface BatchSimResult {
  forward: Array<() => void>
  backward: Array<() => void>
}

/** 把一批 AI 命令在虚拟终态上折叠，产出前进/回退闭包列表。 */
export function simulateBatch(
  batch: AiCommand[],
  ops: BatchOps,
  nodes: CanvasNode[],
  edges: Edge[],
): BatchSimResult {
  const sim: BatchSim = {
    nodes: [...nodes],
    edges: [...edges],
    refToId: new Map(),
    forward: [],
    backward: [],
  }
  for (const cmd of batch) {
    if (cmd.op === 'create_node') simCreate(sim, ops, cmd)
    else if (cmd.op === 'update_node') simUpdate(sim, ops, cmd)
    else if (cmd.op === 'delete_node') simDelete(sim, ops, cmd)
    else if (cmd.op === 'connect_edge') simConnect(sim, ops, cmd)
    else simDisconnect(sim, ops, cmd)
  }
  return { forward: sim.forward, backward: sim.backward }
}
