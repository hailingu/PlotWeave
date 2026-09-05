/**
 * AI 批量命令的折叠模拟器（数据模型 §12：Agent 是命令的另一个生产者）。
 * applyAiBatch 拆出的纯逻辑：把一批命令在「虚拟终态」上折叠执行——
 * 批量创建时场号/镜号基线与 ref→id 引用解析都基于模拟数组，
 * 每条命令的前进/回退闭包在模拟期一次性捕获，不做运行期查询。
 * 产出的 forward/backward 闭包列表由调用方整体入栈为一条复合命令。
 */
import { addEdge, type Edge, type XYPosition } from '@xyflow/react'
import { SCENE_SHOT_HANDLE, branchOptionHandle, removedOptionHandles } from '../graphRules'
import type { CreatableType } from '../creatable'
import { dataPatchOf, mergeNodeData, type NodeDataPatch } from '../nodes/patch'
import type { CanvasNode } from '../nodes/types'
import type { ValidatedCommand } from './commands'

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

/** 模拟器所需的画布写入动作（由 EditorView 注入真实 setState）。
 * applyDataPatch 与 EditorView 共用同一判别化补丁命令（issue 16）。 */
export interface BatchOps {
  buildNewNode: BuildNewNode
  applyDataPatch: (id: string, cmd: NodeDataPatch) => void
  setNodes: (updater: (all: CanvasNode[]) => CanvasNode[]) => void
  setEdges: (updater: (eds: Edge[]) => Edge[]) => void
}

const simCreate = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<ValidatedCommand, { op: 'create_node' }>,
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
  cmd: Extract<ValidatedCommand, { op: 'update_node' }>,
): void => {
  const id = sim.refToId.get(cmd.nodeId) ?? cmd.nodeId
  const target = sim.nodes.find((n) => n.id === id)
  if (!target) return
  const { nodeType, patch } = cmd.patch
  const before: Record<string, unknown> = {}
  for (const k of Object.keys(patch)) before[k] = (target.data as Record<string, unknown>)[k]
  sim.nodes = sim.nodes.map((n) => (n.id === id ? mergeNodeData(n, patch) : n))
  // 分支选项级联（§8.2.2，与 EditorView.patchNode 同规则）：替换 options
  // 删掉的选项，其出口 branch 边一并移除——模拟态与真实画布同一撤销单元
  const removedHandles =
    target.type === 'branch' && nodeType === 'branch' && Array.isArray(patch.options)
      ? removedOptionHandles(target.data.options, patch.options)
      : []
  const removedEdges =
    removedHandles.length > 0
      ? sim.edges.filter((e) => e.source === id && e.sourceHandle && removedHandles.includes(e.sourceHandle))
      : []
  if (removedEdges.length > 0) {
    const gone = new Set(removedEdges.map((e) => e.id))
    sim.edges = sim.edges.filter((e) => !gone.has(e.id))
  }
  sim.forward.push(() => {
    ops.applyDataPatch(id, cmd.patch)
    if (removedEdges.length > 0) {
      const gone = new Set(removedEdges.map((e) => e.id))
      ops.setEdges((eds) => eds.filter((e) => !gone.has(e.id)))
    }
  })
  sim.backward.push(() => {
    // before 与原补丁同键集（值即被替换键的原值），受控构造回收判别形态
    ops.applyDataPatch(id, dataPatchOf(nodeType, before))
    if (removedEdges.length > 0) {
      ops.setEdges((eds) => [...eds, ...removedEdges])
    }
  })
}

const simDelete = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<ValidatedCommand, { op: 'delete_node' }>,
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
  cmd: Extract<ValidatedCommand, { op: 'connect_edge' }>,
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
    // 分支选项出口：端口绑稳定选项 id（删选项不位移其他连线），胶囊文案同源
    const idx = typeof cmd.optionIndex === 'number' ? cmd.optionIndex : 0
    const branchNode = sim.nodes.find((n) => n.id === srcId)
    const option = branchNode?.type === 'branch' ? branchNode.data.options[idx] : undefined
    const handle = branchOptionHandle(option?.id ?? `${idx}`)
    return {
      id: `e-${srcId}-${handle}-${dstId}-ai-${sim.forward.length}`,
      source: srcId,
      target: dstId,
      sourceHandle: handle,
      type: 'branch',
      data: { optionLabel: option?.label ?? '' },
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
  cmd: Extract<ValidatedCommand, { op: 'connect_edge' }>,
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
  cmd: Extract<ValidatedCommand, { op: 'disconnect_edge' }>,
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

/** 把一批 AI 命令在虚拟终态上折叠，产出前进/回退闭包列表。入参为整批
 * 校验通过的执行命令（ValidatedCommand，issue 16）。 */
export function simulateBatch(
  batch: ValidatedCommand[],
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
