/** #931：关联预览与执行共用的确定性计划；模型原始命令始终独立保留。 */
import type { Edge } from '@xyflow/react'
import type { CanvasNode } from '../nodes/types'
import { dataPatchOf } from '../nodes/patch'
import { edgeKindOf } from '../graphRules'
import type { BatchValidation, ValidatedCommand, PreviewItem } from './commands'
import {
  episodeMembers,
  externalEpisodeAnchors,
  projectEpisodeGraph,
  type EpisodeGraph,
  type EpisodeGraphNode,
} from './episodeAssignmentGraph'

/** 执行计划与可持久化的预览元数据；确认状态不在此对象内。 */
export interface EpisodeAssignmentPlan {
  validation: BatchValidation
  commands: ValidatedCommand[]
}

/** 原/目标集的明确显示，未分集保持合法状态。 */
function episodeLabel(value: number | null): string {
  return value === null ? '未分集' : `第 ${value} 集`
}

/** 全部节拍的出向关联索引；未参与本批的节拍同样参与共享冲突判定。 */
function ownersOf(graph: EpisodeGraph): Map<string, EpisodeGraphNode[]> {
  const owners = new Map<string, EpisodeGraphNode[]>()
  for (const beat of graph.nodes.values()) {
    if (beat.type !== 'beat') continue
    for (const id of episodeMembers(graph, beat.id)) {
      const list = owners.get(id) ?? []
      list.push(beat)
      owners.set(id, list)
    }
  }
  return owners
}

/** 节拍和外部锚点使用相同的合法单值集号域。 */
function episodeSet(
  nodes: EpisodeGraphNode[],
  field: 'before' | 'episode',
): Set<number> {
  return new Set(
    nodes.flatMap((node) => (node[field] === null ? [] : [node[field]])),
  )
}

/** 原同组入向内容不凭旧集号制造冲突；未分集节点只与不同目标集的外部锚冲突。 */
function otherOrigins(
  node: EpisodeGraphNode,
  targets: ReadonlySet<number>,
  anchors: EpisodeGraphNode[],
) {
  return anchors.filter((origin) => {
    if (origin.episode === null) return false
    if (node.before === null) return !targets.has(origin.episode)
    return origin.episode !== node.before
  })
}

/** 共享目标不唯一时保留原归属；显式单目标命令仍展示并须冲突确认。 */
function targetOf(
  node: EpisodeGraphNode,
  owners: EpisodeGraphNode[],
  anchors: EpisodeGraphNode[],
  graph: EpisodeGraph,
) {
  const changed = owners.filter((beat) => graph.requested.has(beat.id))
  const targets = episodeSet(owners, 'episode')
  const external = otherOrigins(node, targets, anchors)
  for (const target of episodeSet(external, 'episode')) targets.add(target)
  const shared =
    targets.size > 1 ||
    episodeSet(owners, 'before').size > 1 ||
    external.length > 0
  const explicit = graph.requested.get(node.id)
  const target =
    explicit ?? (targets.size === 1 ? [...targets][0]! : node.before)
  const ownGroup = changed.some(
    (beat) => beat.before !== null && beat.before === node.before,
  )
  const foreign = node.before !== null && node.before !== target && !ownGroup
  const disagreesWithBeat = owners.some(
    (beat) => beat.episode !== null && beat.episode !== target,
  )
  return { target, conflict: shared || foreign || disagreesWithBeat, external }
}

/** 为已有节点追加补丁，新建节点直接补创建载荷；所有写入仍经整批校验与同一历史单元。 */
function addAssignment(
  commands: ValidatedCommand[],
  node: EpisodeGraphNode,
  target: number,
) {
  if (node.createIndex !== undefined) {
    const create = commands[node.createIndex]
    if (create?.op === 'create_node')
      commands[node.createIndex] = {
        ...create,
        data: { ...create.data, episodeNo: target },
      }
  } else if (
    node.type === 'scene' ||
    node.type === 'dialogue' ||
    node.type === 'branch'
  ) {
    commands.push({
      op: 'update_node',
      nodeId: node.id,
      patch: dataPatchOf(node.type, { episodeNo: target }),
    })
  }
}

/** 同一计划的实际命令、完整展示和签名状态共同累积，确认本身不进入此状态。 */
interface AssignmentChanges {
  commands: ValidatedCommand[]
  items: PreviewItem[]
  conflicts: string[]
  state: unknown[]
}

/** 冲突展示区分节拍目标和外部入向内容，不让共享的多个来源被单个目标掩盖。 */
function conflictText(
  label: string,
  node: EpisodeGraphNode,
  owners: EpisodeGraphNode[],
  proposed: ReturnType<typeof targetOf>,
): string {
  const beats = owners
    .map((beat) => [beat.label, episodeLabel(beat.episode)].join(' → '))
    .join('、')
  const incoming = proposed.external
    .map((origin) => [origin.label, episodeLabel(origin.episode)].join(' → '))
    .join('、')
  const sources = incoming ? `其他集入向内容：${incoming}。` : ''
  const decision =
    proposed.target === node.before
      ? '保留原归属，确认后仅执行其他已列改动。'
      : '覆盖须人工确认。'
  return `${label}；存在其他集归属或跨集共享。关联节拍：${beats}。${sources}${decision}`
}

/** 一节点至多追加一次归集补丁；保留的共享节点也在预览明确列出。 */
function appendMemberPlan(
  node: EpisodeGraphNode,
  owners: EpisodeGraphNode[],
  anchors: EpisodeGraphNode[],
  graph: EpisodeGraph,
  changes: AssignmentChanges,
) {
  const proposed = targetOf(node, owners, anchors, graph)
  const { target, conflict } = proposed
  const label = `${node.label}：${episodeLabel(node.before)} → ${episodeLabel(target)}`
  changes.state.push([
    node.id,
    node.type,
    label,
    owners.map((beat) => [beat.id, beat.before, beat.episode]),
  ])
  if (conflict)
    changes.conflicts.push(conflictText(label, node, owners, proposed))
  if (target !== null && target !== node.episode) {
    addAssignment(changes.commands, node, target)
    changes.items.push({
      kind: 'update',
      label,
      danger: false,
      key: `episode-assignment:${node.id}`,
    })
  } else if (conflict) {
    const decision = target === node.before ? '保留' : '显式改集，须确认'
    changes.items.push({
      kind: 'update',
      label: `${label}（${decision}）`,
      danger: false,
      key: `episode-assignment:${node.id}`,
    })
  }
}

/** 绑定输入结构，包含终态投影已删的边，防止旧确认遗漏新增级联删除。 */
function assignmentFingerprint(
  validation: BatchValidation,
  changes: AssignmentChanges,
  nodes: CanvasNode[],
  edges: Edge[],
): string {
  return JSON.stringify([
    validation.commands,
    validation.items,
    changes.state,
    changes.conflicts,
    nodes.map((n) => [
      n.id,
      n.type,
      n.data.episodeNo,
      n.type === 'branch' ? n.data.options : null,
    ]),
    edges.map((e) => [e.id, e.source, e.target, edgeKindOf(e), e.sourceHandle]),
  ])
}

/** 按终态关联补齐预览；共享歧义不猜单值，默认阻断整批等待本次人工确认。 */
export function planEpisodeAssignments(
  validation: BatchValidation,
  nodes: CanvasNode[],
  edges: Edge[],
): EpisodeAssignmentPlan {
  if (!validation.ok) return { validation, commands: validation.commands }
  const graph = projectEpisodeGraph(validation.commands, nodes, edges)
  const roots = new Set(
    [...graph.requested.keys()].filter(
      (id) => graph.nodes.get(id)?.type === 'beat',
    ),
  )
  if (roots.size === 0) return { validation, commands: validation.commands }
  const active = new Map(
    [...ownersOf(graph)].filter(([, owners]) =>
      owners.some((beat) => roots.has(beat.id)),
    ),
  )
  const anchors = externalEpisodeAnchors(graph, new Set(active.keys()))
  const changes: AssignmentChanges = {
    commands: [...validation.commands],
    items: [...validation.items],
    conflicts: [],
    state: [...roots].map((id) => graph.nodes.get(id)),
  }
  for (const [id, owners] of active) {
    const node = graph.nodes.get(id)
    if (node)
      appendMemberPlan(node, owners, anchors.get(id) ?? [], graph, changes)
  }
  const fingerprint = assignmentFingerprint(validation, changes, nodes, edges)
  return {
    commands: changes.commands,
    validation: {
      ...validation,
      items: changes.items,
      episodeAssignment: {
        fingerprint,
        conflicts: changes.conflicts,
        commandCount: changes.commands.length,
      },
    },
  }
}
