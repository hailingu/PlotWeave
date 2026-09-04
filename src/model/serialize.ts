/**
 * 会话文档 ⇄ ProjectDocument 的序列化方向（docs/data-model.md v1 §3）。
 * 序列化只存语义字段：React Flow 运行态（selected/className/measured…）
 * 在此剥离；fromDocument 在归一化完成后把落盘文档还原进会话。
 */
import type { Edge } from '@xyflow/react'
import type { CanvasNode } from '../editor/nodes/types'
import {
  branchOptionIdOf,
  edgeKindOf,
  SCENE_SHOT_HANDLE,
} from '../editor/graphRules'
import type { ProjectSettings } from '../editor/settings'
import type { ProjectContent } from './content'
import {
  CURRENT_SCHEMA_VERSION,
  type BeatSpec,
  type BranchSpec,
  type DialogueSpec,
  type ImageSpec,
  type LabeledMeta,
  type ProjectDocument,
  type SceneSpec,
  type ShotSpec,
  type StoryEdge,
  type StoryNode,
} from './document'
import { normalizeEpisodeTitles } from './legacy'

/** 节点 → 落盘形态：四分区拆分；name/episodeNo 上移 meta，其余字段进 spec。
 * meta 按 type 判别（§4.1）：名称型节点 label 必填（运行态保证有 name，
 * 缺失时兜底空串），branch/shot 不落 label 镜像。可选布局字段 size/zIndex
 * 与 React Flow 的 width/height/zIndex 互转，携带即落盘（§4.1）。 */
export function toStoryNode(n: CanvasNode): StoryNode {
  const { name, episodeNo, ...spec } = n.data as Record<string, unknown> & {
    name?: string
    episodeNo?: number
  }
  const optionalMeta =
    episodeNo !== undefined ? { episodeNo } : {}
  const optionalLayout = {
    ...(typeof n.width === 'number' && typeof n.height === 'number'
      ? { size: { width: n.width, height: n.height } }
      : {}),
    ...(n.zIndex !== undefined ? { zIndex: n.zIndex } : {}),
  }
  const base = {
    id: n.id,
    layout: { position: { x: n.position.x, y: n.position.y }, ...optionalLayout },
    ui: { selected: false, expanded: true },
  }
  // meta 时间戳透传（§4.1 演进占位）：会话带上才写回，缺失即省略
  const ts = n.meta as { createdAt?: unknown; updatedAt?: unknown } | undefined
  const passthroughTs = {
    ...(typeof ts?.createdAt === 'string' ? { createdAt: ts.createdAt } : {}),
    ...(typeof ts?.updatedAt === 'string' ? { updatedAt: ts.updatedAt } : {}),
  }
  if (n.type === 'branch' || n.type === 'shot' || n.type === 'image') {
    // 派生标题节点：不落 meta.label 镜像；分镜卡随宿主场景分集、图片节点
    // 非叙事单元不进大纲分组，均不落独立 episodeNo（§3.5/§13）
    const meta =
      n.type === 'branch' ? { ...optionalMeta, ...passthroughTs } : { ...passthroughTs }
    return {
      ...base,
      type: n.type,
      data: { spec: spec as unknown as BranchSpec & ShotSpec & ImageSpec, meta },
    } as unknown as StoryNode
  }
  const labeled: LabeledMeta = { label: name ?? '', ...optionalMeta, ...passthroughTs }
  return {
    ...base,
    type: n.type,
    data: { spec: spec as unknown as SceneSpec & BeatSpec & DialogueSpec, meta: labeled },
  } as unknown as StoryNode
}

/** 落盘节点 → 运行态：meta/spec 拍平回 data，ui.selected 恒为 false；
 * 可选 layout.size/zIndex 恢复为 React Flow 的 width/height/zIndex；
 * meta.createdAt/updatedAt（§4.1 演进占位）经顶层 meta 透传，非字符串
 * 值不带（下游不落盘即剥离）。 */
export function fromStoryNode(n: StoryNode): CanvasNode {
  const { spec, meta } = n.data
  const data: Record<string, unknown> = { ...(spec as unknown as Record<string, unknown>) }
  if ('label' in meta) data.name = meta.label
  if ('episodeNo' in meta && meta.episodeNo !== undefined) data.episodeNo = meta.episodeNo
  const metaTs: { createdAt?: string; updatedAt?: string } = {}
  if (typeof meta.createdAt === 'string') metaTs.createdAt = meta.createdAt
  if (typeof meta.updatedAt === 'string') metaTs.updatedAt = meta.updatedAt
  const passthrough =
    metaTs.createdAt !== undefined || metaTs.updatedAt !== undefined ? { meta: metaTs } : {}
  return {
    id: n.id,
    type: n.type,
    position: { x: n.layout.position.x, y: n.layout.position.y },
    ...(n.layout.size ? { width: n.layout.size.width, height: n.layout.size.height } : {}),
    ...(n.layout.zIndex !== undefined ? { zIndex: n.layout.zIndex } : {}),
    selected: false,
    ...passthrough,
    data,
  } as CanvasNode
}

/** 边 → 落盘形态：kind 显式化；branch 胶囊文案是分支选项的派生物，不落拷贝。
 * §5 匿名端口唯一：targetHandle 与 sequence 的 sourceHandle 无法绑定真实
 * 端口（命令层拒绝、加载归一化剥离同域），落盘一律省略。 */
export function toStoryEdge(e: Edge): StoryEdge {
  const base = { id: e.id, source: e.source, target: e.target }
  const order = (e.data as { order?: number } | undefined)?.order
  const optionalOrder = order !== undefined ? { order } : {}
  const kind = edgeKindOf(e)
  if (kind === 'branch') {
    // branch 边必带选项句柄（§5 判别联合）；无句柄属非法形态，归一化按孤儿边隔离
    return { ...base, sourceHandle: e.sourceHandle ?? '', data: { kind: 'branch', ...optionalOrder } }
  }
  if (kind === 'attach') {
    // attach 定义上只从 shots 端口发起（§4.3）：句柄恒为 shots，
    // 顺带归一化历史遗留的缺失/异常句柄
    return { ...base, sourceHandle: SCENE_SHOT_HANDLE, data: { kind: 'attach', ...optionalOrder } }
  }
  return { ...base, data: { kind: 'sequence', ...optionalOrder } }
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

/** 落盘文档 → 会话文档（归一化之后调用）。视口/资产桶缺省字段保持缺省：
 * 视口缺省 = 打开时 fitView；资产缺省 = 无资产（透传桶，见 content.ts）。
 * episodeTitles 键值域严格化在此收口（§11.1，对所有版本统一执行）。 */
export function fromDocument(doc: ProjectDocument, warnings: string[]): ProjectContent {
  const nodesById = new Map(doc.graph.nodes.map((n) => [n.id, n]))
  return {
    name: doc.project.name,
    description: doc.project.description,
    createdAt: doc.project.createdAt || undefined,
    nodes: doc.graph.nodes.map(fromStoryNode),
    edges: doc.graph.edges.map((e) => fromStoryEdge(e, nodesById)),
    settings: fromDocSettings(doc.settings),
    episodeTitles: normalizeEpisodeTitles(doc.episodeTitles, warnings),
    viewport: doc.graph.viewport,
    assets: doc.assets,
  }
}
