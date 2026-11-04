/** #931：仅投影关联判断所需的节点/剧情边；不分配持久 id、不写状态。 */
import type { Edge } from '@xyflow/react'
import {
  branchOptionHandle,
  edgeKindOf,
  removedOptionHandles,
} from '../graphRules'
import type { CanvasNode } from '../nodes/types'
import type { ValidatedCommand } from './commands'
import { spineNodeLabel } from './graphDigest'

/** 关联投影节点：原归属用于判断同组移动，目标归属用于跨集共享判断。 */
export interface EpisodeGraphNode {
  id: string
  type: string
  label: string
  before: number | null
  episode: number | null
  createIndex?: number
  options: Array<{ id: string; label: string }>
}

/** 归属计划使用的批次终态图及显式集号意图。 */
export interface EpisodeGraph {
  nodes: Map<string, EpisodeGraphNode>
  edges: Edge[]
  requested: Map<string, number>
}

/** 空值在投影中保持未分集；合法批次中的非空集号已由字段协议校验。 */
function episode(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

/** 按批次顺序解析 ref 和拓扑变化，与执行器的 last-wins 别名及删除语义一致。 */
export function projectEpisodeGraph(
  batch: ValidatedCommand[],
  nodes: CanvasNode[],
  edges: Edge[],
): EpisodeGraph {
  const graph: EpisodeGraph = {
    nodes: new Map(
      nodes.map((n) => [
        n.id,
        {
          id: n.id,
          type: n.type,
          label: spineNodeLabel(n),
          before: episode(n.data.episodeNo),
          episode: episode(n.data.episodeNo),
          options: n.type === 'branch' ? n.data.options : [],
        },
      ]),
    ),
    edges: [...edges],
    requested: new Map(),
  }
  const refs = new Map<string, string>()
  const resolve = (token: string) => refs.get(token) ?? token
  batch.forEach((command, index) => {
    if (command.op === 'create_node') {
      projectCreate(graph, refs, command, index)
    } else if (command.op === 'update_node') {
      projectUpdate(graph, resolve(command.nodeId), command.patch.patch)
    } else if (command.op === 'delete_node') {
      const id = resolve(command.nodeId)
      graph.nodes.delete(id)
      graph.requested.delete(id)
      graph.edges = graph.edges.filter(
        (e) => e.source !== id && e.target !== id,
      )
    } else if (command.op === 'disconnect_edge') {
      graph.edges = graph.edges.filter(
        (e) =>
          e.source !== resolve(command.sourceId) ||
          e.target !== resolve(command.targetId),
      )
    } else if (command.op === 'connect_edge') {
      const source = resolve(command.sourceId)
      const option = graph.nodes.get(source)?.options[command.optionIndex ?? -1]
      graph.edges.push({
        id: `__episode_edge:${index}`,
        source,
        target: resolve(command.targetId),
        type: command.edgeKind === 'branch' ? 'branch' : undefined,
        ...(command.edgeKind === 'attach'
          ? { className: 'pw-edge-attach' }
          : {}),
        ...(command.edgeKind === 'branch' && option
          ? { sourceHandle: branchOptionHandle(option.id) }
          : {}),
      })
    }
  })
  return graph
}

/** 已归一选项收窄为稳定 id/文案，供批次后续连线及删选项级联消费。 */
function optionsOf(value: unknown): EpisodeGraphNode['options'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('id' in item) ||
      !('label' in item)
    )
      return []
    return typeof item.id === 'string' && typeof item.label === 'string'
      ? [{ id: item.id, label: item.label }]
      : []
  })
}

/** 新节点采用仅本次投影可见的唯一身份；追加集号时仍修改原 create 而不泄漏该身份。 */
function projectCreate(
  graph: EpisodeGraph,
  refs: Map<string, string>,
  command: Extract<ValidatedCommand, { op: 'create_node' }>,
  index: number,
) {
  let id = `__episode_create:${index}`
  while (graph.nodes.has(id)) id += ':'
  if (command.ref) refs.set(command.ref, id)
  graph.nodes.set(id, {
    id,
    type: command.nodeType,
    label: createdLabel(command, index),
    before: null,
    episode: episode(command.data.episodeNo),
    createIndex: index,
    options: optionsOf(command.data.options),
  })
  if (typeof command.data.episodeNo === 'number')
    graph.requested.set(id, command.data.episodeNo)
}

/** 名称字段已经过批次校验；仍用类型收窄避免对宽记录进行对象字符串化。 */
function createdLabel(
  command: Extract<ValidatedCommand, { op: 'create_node' }>,
  index: number,
): string {
  if (typeof command.data.name === 'string') return command.data.name
  if (typeof command.data.prompt === 'string') return command.data.prompt
  return command.ref ?? `新节点 ${index + 1}`
}

/** 节点字段与删选项级联同步投影，避免对本批将删除的路径继续归集。 */
function projectUpdate(
  graph: EpisodeGraph,
  id: string,
  patch: Record<string, unknown>,
) {
  const node = graph.nodes.get(id)
  if (!node) return
  if (typeof patch.episodeNo === 'number') {
    node.episode = patch.episodeNo
    graph.requested.set(id, patch.episodeNo)
  }
  if (typeof patch.name === 'string') node.label = patch.name
  if (typeof patch.prompt === 'string') node.label = patch.prompt
  if (node.type === 'branch' && Array.isArray(patch.options)) {
    const removed = removedOptionHandles(node.options, patch.options)
    graph.edges = graph.edges.filter(
      (e) => e.source !== id || !removed.includes(e.sourceHandle ?? ''),
    )
    node.options = optionsOf(patch.options)
  }
}

/** 从节拍出向遍历叙事节点，下一节拍/非叙事节点停止；迭代 visited 防环及重复。 */
export function episodeMembers(
  graph: EpisodeGraph,
  beatId: string,
): Set<string> {
  const next = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (edgeKindOf(edge) === 'attach') continue
    const targets = next.get(edge.source) ?? []
    targets.push(edge.target)
    next.set(edge.source, targets)
  }
  const members = new Set<string>()
  const pending = [...(next.get(beatId) ?? [])]
  while (pending.length > 0) {
    const id = pending.pop()!
    const node = graph.nodes.get(id)
    if (
      !node ||
      members.has(id) ||
      !['scene', 'dialogue', 'branch'].includes(node.type)
    )
      continue
    members.add(id)
    pending.push(...(next.get(id) ?? []))
  }
  return members
}

/** 只收集出向归集集合之外的入向叙事锚点；不把入边变成归集路径，逆向遇节拍停止。 */
export function externalEpisodeAnchors(
  graph: EpisodeGraph,
  members: ReadonlySet<string>,
): Map<string, EpisodeGraphNode[]> {
  const incoming = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (edgeKindOf(edge) === 'attach') continue
    const sources = incoming.get(edge.target) ?? []
    sources.push(edge.source)
    incoming.set(edge.target, sources)
  }
  const result = new Map<string, EpisodeGraphNode[]>()
  for (const member of members) {
    result.set(member, incomingAnchorsFor(graph, incoming, members, member))
  }
  return result
}

/** 每个归集目标独立遍历入向祖先，visited 防环，同时保留共享来源的逐节点提示。 */
function incomingAnchorsFor(
  graph: EpisodeGraph,
  incoming: ReadonlyMap<string, string[]>,
  members: ReadonlySet<string>,
  member: string,
): EpisodeGraphNode[] {
  const anchors: EpisodeGraphNode[] = []
  const visited = new Set([member])
  const pending = [...(incoming.get(member) ?? [])]
  while (pending.length > 0) {
    const id = pending.pop()! // 非空栈已由循环条件保证。
    if (visited.has(id)) continue
    visited.add(id)
    const source = graph.nodes.get(id)
    if (!source || !['scene', 'dialogue', 'branch'].includes(source.type))
      continue
    if (!members.has(id) && source.episode !== null) anchors.push(source)
    pending.push(...(incoming.get(id) ?? []))
  }
  return anchors
}
