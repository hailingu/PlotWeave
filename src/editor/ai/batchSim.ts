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
import {
  createCharacter,
  createLocation,
  EMPTY_SETTINGS,
  type ProjectSettings,
} from '../settings'
import type { ValidatedCommand } from './commands'

/** 模拟器的虚拟终态与闭包收集。 */
interface BatchSim {
  nodes: CanvasNode[]
  edges: Edge[]
  /** 设定集工作副本（issue 44）：同批先建后改的 before 捕获按投影态计算。 */
  settings: ProjectSettings
  /** 节点 ref 别名 → 节点 id（本批新建）。 */
  refToId: Map<string, string>
  /** 实体 ref 别名 → 真实实体 id（本批新建或别名既有）。 */
  entityRefToId: Map<string, string>
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
 * applyDataPatch 与 EditorView 共用同一判别化补丁命令（issue 16）；
 * setSettings（issue 44）承载设定集实体的功能式写入——undo/redo 与
 * 节点绑定同一复合命令，两侧同时恢复。 */
export interface BatchOps {
  buildNewNode: BuildNewNode
  applyDataPatch: (id: string, cmd: NodeDataPatch) => void
  setNodes: (updater: (all: CanvasNode[]) => CanvasNode[]) => void
  setEdges: (updater: (eds: Edge[]) => Edge[]) => void
  setSettings: (updater: (prev: ProjectSettings) => ProjectSettings) => void
}

const simCreate = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<ValidatedCommand, { op: 'create_node' }>,
): void => {
  // create 载荷与 update 补丁同一 ref 解析口径（issue 44）：新建场景/对白
  // 的绑定引用在落画布前解析为真实 id，临时 ref 不进画布、不落盘
  const data = resolveEntityRefs(
    cmd.nodeType,
    (cmd.data as Record<string, unknown>) ?? {},
    sim.entityRefToId,
  )
  const node = ops.buildNewNode(cmd.nodeType as CreatableType, {
    selected: false,
    data,
    against: sim.nodes,
  })
  if (typeof cmd.ref === 'string' && cmd.ref !== '') sim.refToId.set(cmd.ref, node.id)
  sim.nodes = [...sim.nodes, node]
  sim.forward.push(() => ops.setNodes((all) => [...all, node]))
  sim.backward.push(() => ops.setNodes((all) => all.filter((n) => n.id !== node.id)))
}

/** 场景/对白载荷里的实体 ref → 真实 id（issue 44）：create 载荷与 update
 * 补丁共用同一解析（执行期一次性解析，临时 ref 不落盘——验收标准：无临时
 * ref 残留）。非 ref 值原样保留；克隆只发生在确有替换的成员上。 */
function resolveEntityRefs(
  nodeType: string,
  fields: Record<string, unknown>,
  refs: Map<string, string>,
): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...fields }
  const token = (v: unknown): unknown =>
    typeof v === 'string' ? (refs.get(v) ?? v) : v
  if (nodeType === 'scene') {
    if (raw.locationId !== undefined) raw.locationId = token(raw.locationId)
    if (Array.isArray(raw.characterIds)) raw.characterIds = raw.characterIds.map(token)
  }
  if (nodeType === 'dialogue' && Array.isArray(raw.lines)) {
    raw.lines = raw.lines.map((l) => {
      if (
        typeof l === 'object' &&
        l !== null &&
        (l as { kind?: unknown }).kind === 'line' &&
        typeof (l as { speaker?: unknown }).speaker === 'string' &&
        refs.has((l as { speaker: string }).speaker)
      ) {
        return { ...(l as Record<string, unknown>), speaker: refs.get((l as { speaker: string }).speaker) }
      }
      return l
    })
  }
  return raw
}

const simUpdate = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<ValidatedCommand, { op: 'update_node' }>,
): void => {
  const id = sim.refToId.get(cmd.nodeId) ?? cmd.nodeId
  const target = sim.nodes.find((n) => n.id === id)
  if (!target) return
  // 判别联合解构（nodeType 与原 patch 相关，分支级联的 options 收窄依赖它）；
  // patch 为实体 ref 解析后的记录（issue 44）——不触碰 options，级联语义不变
  const { nodeType, patch: originalPatch } = cmd.patch
  const patch = resolveEntityRefs(nodeType, cmd.patch.patch, sim.entityRefToId)
  const before: Record<string, unknown> = {}
  for (const k of Object.keys(patch)) before[k] = (target.data as Record<string, unknown>)[k]
  sim.nodes = sim.nodes.map((n) => (n.id === id ? mergeNodeData(n, patch) : n))
  // 分支选项级联（§8.2.2，与 EditorView.patchNode 同规则）：替换 options
  // 删掉的选项，其出口 branch 边一并移除——模拟态与真实画布同一撤销单元
  const removedHandles =
    target.type === 'branch' && nodeType === 'branch' && Array.isArray(originalPatch.options)
      ? removedOptionHandles(target.data.options, originalPatch.options)
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
    ops.applyDataPatch(id, dataPatchOf(nodeType, patch))
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
    // 分支选项出口：端口绑稳定选项 id（删选项不位移其他连线）；胶囊文案
    // 由 BranchEdge 按 sourceHandle 实时派生，运行态不落镜像
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
  // 断线按端点对整体生效（与校验侧 foldDisconnectEdge 同口径）：模拟态、
  // forward（画布删除）与 backward（撤销还原）三者都作用于全部匹配边——
  // 只捕获/回补首条会让撤销静默丢失其余边（评审 5174231991）
  const removed = sim.edges.filter((e) => e.source === srcId && e.target === dstId)
  if (removed.length === 0) return
  sim.edges = sim.edges.filter((e) => e.source !== srcId || e.target !== dstId)
  sim.forward.push(() =>
    ops.setEdges((eds) => eds.filter((e) => e.source !== srcId || e.target !== dstId)),
  )
  sim.backward.push(() => ops.setEdges((eds) => removed.reduce((acc, e) => addEdge(e, acc), eds)))
}

/** 新建实体（issue 44）：真实 id 与默认头像样式由应用工厂分配（模拟期一次），
 * 撤销-重做复用同一实体对象——往返不改变实体 id 与既有引用。 */
const simEntityCreate = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<ValidatedCommand, { op: 'upsert_character' | 'upsert_location' }>,
  kind: 'character' | 'location',
): void => {
  const fields = cmd.fields
  const entity =
    kind === 'character'
      ? (() => {
          const c = createCharacter(fields.name ?? '')
          if (typeof fields.bio === 'string') c.bio = fields.bio
          return c
        })()
      : (() => {
          const l = createLocation(fields.name ?? '')
          if (typeof fields.note === 'string') l.note = fields.note
          return l
        })()
  const bucket = kind === 'character' ? 'characters' : 'locations'
  const ref = typeof cmd.ref === 'string' && cmd.ref !== '' ? cmd.ref : undefined
  if (ref !== undefined) sim.entityRefToId.set(ref, entity.id)
  sim.settings = {
    ...sim.settings,
    [bucket]: [...sim.settings[bucket], entity],
  } as ProjectSettings
  sim.forward.push(() =>
    ops.setSettings((prev) => ({ ...prev, [bucket]: [...prev[bucket], entity] }) as ProjectSettings),
  )
  sim.backward.push(() =>
    ops.setSettings(
      (prev) =>
        ({
          ...prev,
          [bucket]: (prev[bucket] as Array<{ id: string }>).filter((e) => e.id !== entity.id),
        }) as ProjectSettings,
    ),
  )
}

/** 修改既有实体（issue 44）：只覆盖 fields 写到的键，未提及字段保持执行时
 * 现值；before 实体对象取自工作副本（同批先建后改不互相覆盖），undo 反序
 * 回放精确还原。 */
const simEntityUpdate = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<ValidatedCommand, { op: 'upsert_character' | 'upsert_location' }>,
  kind: 'character' | 'location',
): void => {
  const bucket = kind === 'character' ? 'characters' : 'locations'
  const token = typeof cmd.entityId === 'string' ? cmd.entityId : ''
  const id = sim.entityRefToId.get(token) ?? token
  const list = sim.settings[bucket] as Array<{ id: string }>
  const target = list.find((e) => e.id === id)
  if (!target) return
  const next = { ...target }
  for (const [k, v] of Object.entries(cmd.fields)) (next as Record<string, unknown>)[k] = v
  sim.settings = {
    ...sim.settings,
    [bucket]: list.map((e) => (e.id === id ? next : e)),
  } as ProjectSettings
  const ref = typeof cmd.ref === 'string' && cmd.ref !== '' ? cmd.ref : undefined
  if (ref !== undefined) sim.entityRefToId.set(ref, id)
  sim.forward.push(() =>
    ops.setSettings(
      (prev) =>
        ({
          ...prev,
          [bucket]: (prev[bucket] as Array<{ id: string }>).map((e) => (e.id === id ? next : e)),
        }) as ProjectSettings,
    ),
  )
  sim.backward.push(() =>
    ops.setSettings(
      (prev) =>
        ({
          ...prev,
          [bucket]: (prev[bucket] as Array<{ id: string }>).map((e) => (e.id === id ? target : e)),
        }) as ProjectSettings,
    ),
  )
}

const simUpsert = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<ValidatedCommand, { op: 'upsert_character' | 'upsert_location' }>,
  kind: 'character' | 'location',
): void => {
  if (typeof cmd.entityId === 'string' && cmd.entityId.trim() !== '') {
    simEntityUpdate(sim, ops, cmd, kind)
  } else {
    simEntityCreate(sim, ops, cmd, kind)
  }
}

/** 批次折叠执行的结果：forward 按命令顺序生效；backward 反序回放即整批回滚。 */
export interface BatchSimResult {
  forward: Array<() => void>
  backward: Array<() => void>
}

/** 把一批 AI 命令在虚拟终态上折叠，产出前进/回退闭包。入参为整批
 * 校验通过的执行命令（ValidatedCommand，issue 16）；settings（issue 44）
 * 为执行时的当前设定集，实体改动与节点绑定共用一个撤销单元。 */
export function simulateBatch(
  batch: ValidatedCommand[],
  ops: BatchOps,
  nodes: CanvasNode[],
  edges: Edge[],
  settings: ProjectSettings = EMPTY_SETTINGS,
): BatchSimResult {
  const sim: BatchSim = {
    nodes: [...nodes],
    edges: [...edges],
    settings,
    refToId: new Map(),
    entityRefToId: new Map(),
    forward: [],
    backward: [],
  }
  for (const cmd of batch) {
    if (cmd.op === 'create_node') simCreate(sim, ops, cmd)
    else if (cmd.op === 'update_node') simUpdate(sim, ops, cmd)
    else if (cmd.op === 'delete_node') simDelete(sim, ops, cmd)
    else if (cmd.op === 'connect_edge') simConnect(sim, ops, cmd)
    else if (cmd.op === 'disconnect_edge') simDisconnect(sim, ops, cmd)
    else if (cmd.op === 'upsert_character') simUpsert(sim, ops, cmd, 'character')
    else simUpsert(sim, ops, cmd, 'location')
  }
  return { forward: sim.forward, backward: sim.backward }
}
