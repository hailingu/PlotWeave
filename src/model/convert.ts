/**
 * 会话文档 ⇄ ProjectDocument 互转与归一化管线（docs/data-model.md v1 §3/§11）。
 * 序列化只存语义字段：React Flow 运行态（selected/className/measured…）在此剥离；
 * 归一化保证任何历史版本的文档都以当前形态进入会话——修复而非拒绝，
 * 单条坏数据（孤儿边、悬空引用）只记警告，不阻断加载。
 */
import type { Edge } from '@xyflow/react'
import type { CanvasNode } from '../editor/nodes/types'
import {
  branchOptionIdOf,
  edgeKindOf,
} from '../editor/graphRules'
import type { ProjectSettings } from '../editor/settings'
import type { ProjectContent } from './content'
import {
  CURRENT_SCHEMA_VERSION,
  type BranchSpec,
  type ProjectDocument,
  type StoryEdge,
  type StoryNode,
  type Viewport,
} from './document'
import { migrateProjectDocument, normalizeEpisodeTitles, rewriteIndexOptionHandles } from './legacy'

/** 节点 → 落盘形态：四分区拆分；name/episodeNo 上移 meta，其余字段进 spec。 */
export function toStoryNode(n: CanvasNode): StoryNode {
  const { name, episodeNo, ...spec } = n.data as Record<string, unknown> & {
    name?: string
    episodeNo?: number
  }
  const meta: StoryNode['data']['meta'] = {}
  // 分支/分镜卡无 name：标题由 prompt/shotNo 派生，不落 meta.label 镜像
  if (name !== undefined) meta.label = name
  if (episodeNo !== undefined) meta.episodeNo = episodeNo
  return {
    id: n.id,
    type: n.type,
    layout: { position: { x: n.position.x, y: n.position.y } },
    ui: { selected: false, expanded: true },
    data: { spec: spec as unknown as StoryNode['data']['spec'], meta },
  }
}

/** 落盘节点 → 运行态：meta/spec 拍平回 data，ui.selected 恒为 false。 */
export function fromStoryNode(n: StoryNode): CanvasNode {
  const { spec, meta } = n.data
  const data: Record<string, unknown> = { ...(spec as unknown as Record<string, unknown>) }
  if (meta.label !== undefined) data.name = meta.label
  if (meta.episodeNo !== undefined) data.episodeNo = meta.episodeNo
  return {
    id: n.id,
    type: n.type,
    position: { x: n.layout.position.x, y: n.layout.position.y },
    selected: false,
    data,
  } as CanvasNode
}

/** 边 → 落盘形态：kind 显式化；branch 胶囊文案是分支选项的派生物，不落拷贝。 */
export function toStoryEdge(e: Edge): StoryEdge {
  const out: StoryEdge = {
    id: e.id,
    source: e.source,
    target: e.target,
    data: { kind: edgeKindOf(e) },
  }
  // data.order：同 source 多出口的排列顺序（§5），运行态在边 data 里携带
  const order = (e.data as { order?: number } | undefined)?.order
  if (order !== undefined) out.data.order = order
  if (e.sourceHandle) out.sourceHandle = e.sourceHandle
  if (e.targetHandle) out.targetHandle = e.targetHandle
  return out
}

/** 落盘边 → 运行态：恢复 type/className；branch 胶囊文案按 sourceHandle 绑定的选项 id 从分支节点派生；
 * data.order 原样保留。 */
export function fromStoryEdge(e: StoryEdge, nodesById: Map<string, StoryNode>): Edge {
  const out: Edge = { id: e.id, source: e.source, target: e.target }
  if (e.sourceHandle) out.sourceHandle = e.sourceHandle
  if (e.targetHandle) out.targetHandle = e.targetHandle
  const order = e.data.order
  if (e.data.kind === 'branch') {
    out.type = 'branch'
    const optionId = branchOptionIdOf(e.sourceHandle)
    const src = nodesById.get(e.source)
    const options = src?.type === 'branch' ? (src.data.spec as BranchSpec).options : undefined
    out.data = {
      optionLabel: options?.find((o) => o.id === optionId)?.label ?? '',
      ...(order !== undefined ? { order } : {}),
    }
  } else {
    out.className = e.data.kind === 'attach' ? 'pw-edge-attach' : 'pw-edge-sequence'
    if (order !== undefined) out.data = { order }
  }
  return out
}

/** 设定集 → 落盘形态：数组转 Record<id, 实体>。props/documents 首版只透传
 * （UI 未开放编辑），原样回写保真。 */
export function toDocSettings(settings: ProjectSettings): ProjectDocument['settings'] {
  return {
    characters: Object.fromEntries(settings.characters.map((c) => [c.id, c])),
    locations: Object.fromEntries(settings.locations.map((l) => [l.id, l])),
    props: Object.fromEntries((settings.props ?? []).map((p) => [p.id, p])),
    documents: Object.fromEntries((settings.documents ?? []).map((d) => [d.id, d])),
  }
}

/** 设定集 → 运行态：Record 转数组（插入序即展示序），容忍缺桶；
 * props/documents 桶透传进会话（契约实体，不得静默丢弃）。 */
export function fromDocSettings(settings: Partial<ProjectDocument['settings']>): ProjectSettings {
  return {
    characters: Object.values(settings.characters ?? {}),
    locations: Object.values(settings.locations ?? {}),
    props: Object.values(settings.props ?? {}),
    documents: Object.values(settings.documents ?? {}),
  }
}

/**
 * 序列化：会话文档 → ProjectDocument。updatedAt 由时钟参数盖戳（默认现在）；
 * createdAt 缺省时与 updatedAt 同刻（新建项目首次落盘）。视口/资产桶缺省时
 * 省略字段而非伪造缺省值——视口省略 = 打开时 fitView；资产省略 = 无资产。
 */
export function serializeProject(
  content: ProjectContent,
  id: string,
  now: Date = new Date(),
): ProjectDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: {
      id,
      name: content.name,
      description: content.description,
      createdAt: content.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    },
    graph: {
      nodes: content.nodes.map(toStoryNode),
      edges: content.edges.map(toStoryEdge),
      ...(content.viewport ? { viewport: content.viewport } : {}),
    },
    settings: toDocSettings(content.settings),
    episodeTitles: content.episodeTitles ?? {},
    assets: content.assets ?? { byId: {} },
  }
}

export interface ParseResult {
  content: ProjectContent
  /** 发生了格式迁移（v0 → v1），调用方应回写磁盘。 */
  migrated: boolean
  /** 归一化警告：孤儿边隔离、悬空引用标记（§11.3/§11.4）。 */
  warnings: string[]
}

/** 场景节点的悬空角色/地点/头像资产引用警告（§11.4）：只记警告，不清除 id。
 * 桶缺失（Rust 兼容默认 settings:{}）按空集合处理，不抛错。 */
function sceneRefWarnings(
  n: StoryNode,
  doc: ProjectDocument,
  warnings: string[],
): void {
  const s = n.data.spec as { characterIds?: string[]; locationId?: string; avatarAssetId?: string }
  const characters = doc.settings.characters ?? {}
  const locations = doc.settings.locations ?? {}
  for (const cid of s.characterIds ?? []) {
    if (!characters[cid]) {
      warnings.push(`节点 ${n.id} 引用了不存在的角色 ${cid}`)
    }
  }
  if (s.locationId && !locations[s.locationId]) {
    warnings.push(`节点 ${n.id} 引用了不存在的地点 ${s.locationId}`)
  }
  if (s.avatarAssetId && !doc.assets?.byId[s.avatarAssetId]) {
    warnings.push(`节点 ${n.id} 引用了不存在的资产 ${s.avatarAssetId}`)
  }
}

/** 对白节点的悬空 speaker 引用警告（§11.4）：只记警告，不清除 id。 */
function dialogueRefWarnings(
  n: StoryNode,
  doc: ProjectDocument,
  warnings: string[],
): void {
  const characters = doc.settings.characters ?? {}
  for (const line of (n.data.spec as { lines?: { speaker?: string }[] }).lines ?? []) {
    if (line.speaker && !characters[line.speaker]) {
      warnings.push(`节点 ${n.id} 的对白引用了不存在的角色 ${line.speaker}`)
    }
  }
}

/** 分镜节点的悬空引用位警告（§11.4）：targetId 按类别解析到设定集或资产索引。 */
function shotRefWarnings(n: StoryNode, doc: ProjectDocument, warnings: string[]): void {
  for (const ref of (n.data.spec as { refs?: Array<{ id: string; kind: string; targetId?: string }> }).refs ?? []) {
    if (!ref.targetId) continue
    if (!refTargetKnown(doc, ref.kind, ref.targetId)) {
      warnings.push(`节点 ${n.id} 的分镜引用指向不存在的目标 ${ref.targetId}`)
    }
  }
}

/** 引用目标是否可解析：character/location 查设定集，audio 查资产索引。 */
function refTargetKnown(doc: ProjectDocument, kind: string, targetId: string): boolean {
  if (kind === 'character') return !!doc.settings.characters?.[targetId]
  if (kind === 'location') return !!doc.settings.locations?.[targetId]
  return !!doc.assets?.byId[targetId]
}

/** 按节点类型分发悬空设定/资产引用检查（§11.4）。 */
function collectDanglingRefWarnings(
  n: StoryNode,
  doc: ProjectDocument,
  warnings: string[],
): void {
  if (n.type === 'scene') sceneRefWarnings(n, doc, warnings)
  if (n.type === 'dialogue') dialogueRefWarnings(n, doc, warnings)
  if (n.type === 'shot') shotRefWarnings(n, doc, warnings)
}

/** 孤儿边判定（§11.3）：端点节点缺失；branch 边绑定的选项已不存在同论。 */
function isOrphanEdge(e: StoryEdge, nodesById: Map<string, StoryNode>): boolean {
  const src = nodesById.get(e.source)
  if (!src || !nodesById.has(e.target)) return true
  if (e.data.kind !== 'branch') return false
  if (src.type !== 'branch') return true
  const optionId = branchOptionIdOf(e.sourceHandle)
  const options = (src.data.spec as BranchSpec).options
  return optionId === undefined || !options.some((o) => o.id === optionId)
}

/** 归一化（§11.2–§11.4）：重置选中态、隔离孤儿边、标记悬空设定引用。 */
function normalizeDocument(doc: ProjectDocument): { doc: ProjectDocument; warnings: string[] } {
  const warnings: string[] = []
  const nodesById = new Map(doc.graph.nodes.map((n) => [n.id, n]))
  const edges = doc.graph.edges.filter((e) => {
    const orphan = isOrphanEdge(e, nodesById)
    if (orphan) warnings.push(`已隔离孤儿边 ${e.id}：端点节点或绑定选项不存在`)
    return !orphan
  })
  const nodes = doc.graph.nodes.map((n) => {
    collectDanglingRefWarnings(n, doc, warnings)
    return { ...n, ui: { ...n.ui, selected: false } }
  })
  return { doc: { ...doc, graph: { ...doc.graph, nodes, edges } }, warnings }
}

/**
 * 归一化管线入口（§11）：schemaVersion 校验与迁移 → 归一化 → 会话文档。
 * v0 信封（旧扁平格式经 Rust 包装）先走节点字段迁移，再按 v1 解析。
 */
export function parseProject(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('项目文件损坏：不是有效的文档对象')
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion
  if (typeof version !== 'number') {
    throw new TypeError('项目文件损坏：缺少 schemaVersion')
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`文档版本过新（schemaVersion ${version}），请升级应用`)
  }

  if (version === 0) {
    const env = raw as Partial<ProjectDocument> & {
      project?: Partial<ProjectDocument['project']>
      graph?: { nodes?: CanvasNode[]; edges?: Edge[]; viewport?: Viewport }
      settings?: unknown
      episodeTitles?: unknown
    }
    const legacy: ProjectContent = {
      name: env.project?.name ?? '',
      createdAt: env.project?.createdAt || undefined,
      nodes: env.graph?.nodes ?? [],
      edges: env.graph?.edges ?? [],
      settings: (env.settings ?? {}) as ProjectContent['settings'],
      episodeTitles: normalizeEpisodeTitles(env.episodeTitles),
      viewport: env.graph?.viewport,
    }
    const migrated = migrateProjectDocument(legacy)
    const doc = serializeProject(rewriteIndexOptionHandles(migrated.doc), env.project?.id ?? '')
    const { doc: normalized, warnings } = normalizeDocument(doc)
    return { content: fromDocument(normalized), migrated: true, warnings }
  }

  const doc = raw as ProjectDocument
  const { doc: normalized, warnings } = normalizeDocument(doc)
  return { content: fromDocument(normalized), migrated: false, warnings }
}

/** 落盘文档 → 会话文档（归一化之后调用）。视口/资产桶缺省字段保持缺省：
 * 视口缺省 = 打开时 fitView；资产缺省 = 无资产（透传桶，见 content.ts）。 */
function fromDocument(doc: ProjectDocument): ProjectContent {
  const nodesById = new Map(doc.graph.nodes.map((n) => [n.id, n]))
  return {
    name: doc.project.name,
    description: doc.project.description,
    createdAt: doc.project.createdAt || undefined,
    nodes: doc.graph.nodes.map(fromStoryNode),
    edges: doc.graph.edges.map((e) => fromStoryEdge(e, nodesById)),
    settings: fromDocSettings(doc.settings),
    episodeTitles: normalizeEpisodeTitles(doc.episodeTitles),
    viewport: doc.graph.viewport,
    assets: doc.assets,
  }
}
