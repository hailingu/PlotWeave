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
  SCENE_SHOT_HANDLE,
} from '../editor/graphRules'
import type { ProjectSettings } from '../editor/settings'
import type { ProjectContent } from './content'
import {
  CURRENT_SCHEMA_VERSION,
  type BeatSpec,
  type BranchSpec,
  type DialogueSpec,
  type LabeledMeta,
  type ProjectDocument,
  type SceneSpec,
  type ShotSpec,
  type StoryEdge,
  type StoryNode,
  type Viewport,
} from './document'
import { migrateProjectDocument, normalizeEpisodeTitles, rewriteIndexOptionHandles } from './legacy'
import { uid } from '../uid'

/** 节点 → 落盘形态：四分区拆分；name/episodeNo 上移 meta，其余字段进 spec。
 * meta 按 type 判别（§4.1）：名称型节点 label 必填（运行态保证有 name，
 * 缺失时兜底空串），branch/shot 不落 label 镜像。 */
export function toStoryNode(n: CanvasNode): StoryNode {
  const { name, episodeNo, ...spec } = n.data as Record<string, unknown> & {
    name?: string
    episodeNo?: number
  }
  const optionalMeta =
    episodeNo !== undefined ? { episodeNo } : {}
  const base = {
    id: n.id,
    layout: { position: { x: n.position.x, y: n.position.y } },
    ui: { selected: false, expanded: true },
  }
  if (n.type === 'branch' || n.type === 'shot') {
    // 派生标题节点：不落 meta.label 镜像；分镜卡随宿主场景分集，
    // 不落独立 episodeNo（§3.5）
    const meta = n.type === 'shot' ? {} : { ...optionalMeta }
    return {
      ...base,
      type: n.type,
      data: { spec: spec as unknown as BranchSpec & ShotSpec, meta },
    } as unknown as StoryNode
  }
  const labeled: LabeledMeta = { label: name ?? '', ...optionalMeta }
  return {
    ...base,
    type: n.type,
    data: { spec: spec as unknown as SceneSpec & BeatSpec & DialogueSpec, meta: labeled },
  } as unknown as StoryNode
}

/** 落盘节点 → 运行态：meta/spec 拍平回 data，ui.selected 恒为 false。 */
export function fromStoryNode(n: StoryNode): CanvasNode {
  const { spec, meta } = n.data
  const data: Record<string, unknown> = { ...(spec as unknown as Record<string, unknown>) }
  if ('label' in meta) data.name = meta.label
  if ('episodeNo' in meta && meta.episodeNo !== undefined) data.episodeNo = meta.episodeNo
  return {
    id: n.id,
    type: n.type,
    position: { x: n.layout.position.x, y: n.layout.position.y },
    selected: false,
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

export interface ParseResult {
  content: ProjectContent
  /** 发生了格式迁移（v0 → v1），调用方应回写磁盘。 */
  migrated: boolean
  /** 归一化警告：孤儿边隔离、悬空引用标记（§11.3/§11.4）。 */
  warnings: string[]
}

/** 归一化环境（§11.1 第 2 步元数据修复的外部事实来源）。 */
export interface NormalizeEnv {
  /** 来自 load_project 路径的受信项目 id：project.id 缺失/异型/不一致时以它覆盖。 */
  projectId?: string
  /** 项目索引中的合法名称：project.name 非法时优先回退到它。 */
  indexName?: string
}

/** 普通对象：JSON 边界排除了 TypeScript 类型，数组也是 object 须显式排除。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const SETTINGS_BUCKETS = ['characters', 'locations', 'props', 'documents'] as const

/** 按节点类型的必填列表（§4.2 spec 契约）：缺失/非数组可确定性置空，
 * 所属节点保留；指向被清空选项的连线由孤儿边规则处理。 */
const REQUIRED_LISTS: Record<string, string> = {
  scene: 'characterIds',
  dialogue: 'lines',
  branch: 'options',
  shot: 'refs',
}

/** 普通键值对象的成员过滤：非普通对象（含数组——下标 "0"/"1" 会被误当权威实体 id）
 * 整体重置为空 Record，桶内异型条目移除；缺失视为空，不警告。 */
function plainObjectEntries(
  v: unknown,
  label: string,
  warnings: string[],
): Record<string, unknown> {
  if (!isPlainObject(v)) {
    if (v !== undefined) warnings.push(`${label} 非普通键值对象，已重置为空 Record`)
    return {}
  }
  const entries: Record<string, unknown> = {}
  for (const [k, item] of Object.entries(v)) {
    if (isPlainObject(item)) entries[k] = item
    else warnings.push(`${label} 的条目 ${k} 不是普通对象，已移除`)
  }
  return entries
}

/** 设定文档 relatedIds 的形状修复（§6 的 {kind,id} 对）：缺失/非数组置空，异型成员移除。 */
function normalizeRelatedIds(key: string, entry: Record<string, unknown>, warnings: string[]): void {
  const related = entry.relatedIds
  if (!Array.isArray(related)) {
    warnings.push(`设定文档 ${key} 的 relatedIds 缺失或非数组，已重置为空数组`)
    entry.relatedIds = []
    return
  }
  const kept = related.filter((r: unknown) => {
    const ok = isPlainObject(r)
    if (!ok) warnings.push(`设定文档 ${key} 的 relatedIds 含异型成员，已移除`)
    return ok
  })
  if (kept.length !== related.length) entry.relatedIds = kept
}

/** settings 四桶：异型桶重置为空 Record、桶内异型条目移除，随后修复设定文档 relatedIds。 */
function normalizeSettingsBuckets(
  settingsRaw: Record<string, unknown>,
  warnings: string[],
): Record<string, Record<string, unknown>> {
  const settings: Record<string, Record<string, unknown>> = {}
  for (const bucket of SETTINGS_BUCKETS) {
    settings[bucket] = plainObjectEntries(settingsRaw[bucket], `settings.${bucket}`, warnings)
  }
  for (const [k, v] of Object.entries(settings.documents)) {
    // 桶成员已经上方过滤为普通对象
    normalizeRelatedIds(k, v as Record<string, unknown>, warnings)
  }
  return settings
}

/** 节点 spec 必填列表（§4.2）：缺失/非数组可确定性置空，异型成员移除；
 * 指向被清空选项的连线由孤儿边规则处理。 */
function normalizeRequiredList(
  spec: Record<string, unknown>,
  type: unknown,
  nid: string,
  warnings: string[],
): void {
  const listKey = REQUIRED_LISTS[type as string]
  if (!listKey) return
  const list = spec[listKey]
  if (!Array.isArray(list)) {
    warnings.push(`节点 ${nid} 的 spec.${listKey} 缺失或非数组，已重置为空数组`)
    spec[listKey] = []
    return
  }
  const kept = list.filter((item) => {
    const ok = listKey === 'characterIds' ? typeof item === 'string' : isPlainObject(item)
    if (!ok) warnings.push(`节点 ${nid} 的 spec.${listKey} 含异型成员，已移除`)
    return ok
  })
  if (kept.length !== list.length) spec[listKey] = kept
}

/** 单个节点的成员形状校验与机械修复；嵌套容器（data/spec/meta/layout +
 * position 坐标）无法机械修复时隔离该节点（返回 null）。 */
function normalizeNode(member: unknown, warnings: string[]): StoryNode | null {
  if (!isPlainObject(member)) {
    warnings.push('graph.nodes 中的非普通对象成员已隔离')
    return null
  }
  const nid = typeof member.id === 'string' && member.id ? member.id : '(缺失 id)'
  const data = member.data
  const layout = member.layout
  if (
    !isPlainObject(data) ||
    !isPlainObject(data.spec) ||
    !isPlainObject(data.meta) ||
    !isPlainObject(layout)
  ) {
    warnings.push(`节点 ${nid} 的 data/spec/meta/layout 容器缺失或异型，无法机械修复，已隔离`)
    return null
  }
  const pos = layout.position
  if (!isPlainObject(pos) || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
    warnings.push(`节点 ${nid} 的 layout.position 坐标非法，无法机械修复，已隔离`)
    return null
  }
  normalizeRequiredList(data.spec, member.type, nid, warnings)
  const ui = member.ui
  if (!isPlainObject(ui) || typeof ui.selected !== 'boolean' || typeof ui.expanded !== 'boolean') {
    warnings.push(`节点 ${nid} 的 ui 缺失或异型，已重置为默认值`)
    member.ui = { selected: false, expanded: true }
  }
  return member as unknown as StoryNode
}

/** 单个边的成员形状校验：非普通对象或判别依据 data 缺失即无法机械修复，隔离（返回 null）。 */
function normalizeEdge(member: unknown, warnings: string[]): StoryEdge | null {
  if (!isPlainObject(member)) {
    warnings.push('graph.edges 中的非普通对象成员已隔离')
    return null
  }
  if (!isPlainObject(member.data)) {
    warnings.push(
      `边 ${typeof member.id === 'string' && member.id ? member.id : '(缺失 id)'} 的 data 缺失或异型，已隔离`,
    )
    return null
  }
  return member as unknown as StoryEdge
}

/** 名称修复链：trim 后合法则采用，否则回退索引名，再退「未命名项目」。 */
function normalizeProjectName(rawName: unknown, env: NormalizeEnv, warnings: string[]): string {
  const fallbackName = (): string => {
    const idx = typeof env.indexName === 'string' ? env.indexName.trim() : ''
    return idx && [...idx].length <= 64 ? idx : '未命名项目'
  }
  if (typeof rawName !== 'string') {
    const name = fallbackName()
    warnings.push(`project.name 缺失或非字符串，已回退为「${name}」`)
    return name
  }
  const trimmed = rawName.trim()
  if (!trimmed || [...trimmed].length > 64) {
    const name = fallbackName()
    warnings.push(`project.name 空白或超过 64 字符，已回退为「${name}」`)
    return name
  }
  if (trimmed !== rawName) warnings.push('project.name 已去首尾空白')
  return trimmed
}

/** 项目必填元数据修复：受信 id 覆盖、名称回退链、时间戳修复、非字符串描述剥离。 */
function normalizeProjectMeta(
  projectRaw: Record<string, unknown>,
  env: NormalizeEnv,
  warnings: string[],
): { id: string; name: string; description?: string; createdAt: string; updatedAt: string } {
  const rawId = projectRaw.id
  let id: string
  if (env.projectId !== undefined) {
    if (rawId !== env.projectId) {
      warnings.push(`project.id（${String(rawId)}）与受信项目 id 不一致，已覆盖为 ${env.projectId}`)
    }
    id = env.projectId
  } else {
    id = typeof rawId === 'string' ? rawId : ''
  }
  const name = normalizeProjectName(projectRaw.name, env, warnings)
  const parseableIso = (v: unknown): v is string =>
    typeof v === 'string' && Number.isFinite(Date.parse(v))
  let updatedAt: string
  if (parseableIso(projectRaw.updatedAt)) {
    updatedAt = projectRaw.updatedAt
  } else {
    warnings.push('project.updatedAt 不是可解析的时间戳，已取本次加载时刻')
    updatedAt = new Date().toISOString()
  }
  let createdAt: string
  if (parseableIso(projectRaw.createdAt)) {
    createdAt = projectRaw.createdAt
  } else {
    warnings.push('project.createdAt 不是可解析的时间戳，已采用修复后的 updatedAt')
    createdAt = updatedAt
  }
  let description: string | undefined
  if (projectRaw.description !== undefined) {
    if (typeof projectRaw.description === 'string') description = projectRaw.description
    else warnings.push('project.description 非字符串，已剥离')
  }
  return { id, name, description, createdAt, updatedAt }
}

/** 视口形状校验：非法即删除（回退打开时 fitView，§3 缺省语义）。 */
function normalizeViewportShape(v: unknown, warnings: string[]): Viewport | undefined {
  if (v === undefined) return undefined
  if (
    isPlainObject(v) &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Number.isFinite(v.zoom) &&
    (v.zoom as number) > 0
  ) {
    return { x: v.x as number, y: v.y as number, zoom: v.zoom as number }
  }
  warnings.push('graph.viewport 形状非法，已删除（打开时 fitView）')
  return undefined
}

/** §11.1 第 2 步容器级形状校验（先于一切逐项规则；父容器先于子容器）：
 * 异型父/子容器重置为可遍历空容器，非普通对象成员过滤，节点嵌套容器
 * （data/spec/meta/layout + position 坐标）无法机械修复时隔离该节点，
 * 项目必填元数据补齐（受信 id 覆盖、名称回退链、时间戳修复），节点 ui
 * 默认值补齐。修复而非拒绝：均记录警告，单个脏字段不阻断加载（§8.2.4）。 */
function normalizeContainers(
  raw: Record<string, unknown>,
  env: NormalizeEnv,
  warnings: string[],
): ProjectDocument {
  // 父/子容器（异型重置为可遍历空容器；缺失视为空，不警告）
  const containerOf = (v: unknown, warning: string): Record<string, unknown> => {
    if (isPlainObject(v)) return v
    if (v !== undefined) warnings.push(warning)
    return {}
  }
  const arrayOf = (v: unknown, warning: string): unknown[] => {
    if (Array.isArray(v)) return v
    if (v !== undefined) warnings.push(warning)
    return []
  }
  const projectRaw = containerOf(raw.project, 'project 容器异型，已重置为空对象后逐字段修复')
  const graphRaw = containerOf(raw.graph, 'graph 容器异型，已重置为空画布')
  const settingsRaw = containerOf(raw.settings, 'settings 容器异型，已重置为默认空桶')
  const assetsRaw = containerOf(raw.assets, 'assets 容器异型，已重置为空资产索引')
  const nodesRaw = arrayOf(graphRaw.nodes, 'graph.nodes 非数组，已重置为空数组')
  const edgesRaw = arrayOf(graphRaw.edges, 'graph.edges 非数组，已重置为空数组')

  // 成员过滤 + 嵌套容器修复
  const settings = normalizeSettingsBuckets(settingsRaw, warnings)
  const byId = plainObjectEntries(assetsRaw.byId, 'assets.byId', warnings)
  const titlesRaw = containerOf(raw.episodeTitles, 'episodeTitles 非普通键值对象，已重置为空 Record')
  const nodes: StoryNode[] = []
  for (const member of nodesRaw) {
    const node = normalizeNode(member, warnings)
    if (node) nodes.push(node)
  }
  const edges: StoryEdge[] = []
  for (const member of edgesRaw) {
    const edge = normalizeEdge(member, warnings)
    if (edge) edges.push(edge)
  }

  // 项目必填元数据（容器就位后、逐项规则前补齐）
  const meta = normalizeProjectMeta(projectRaw, env, warnings)
  const viewport = normalizeViewportShape(graphRaw.viewport, warnings)

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: {
      id: meta.id,
      name: meta.name,
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    },
    graph: { nodes, edges, ...(viewport ? { viewport } : {}) },
    settings: settings as unknown as ProjectDocument['settings'],
    episodeTitles: titlesRaw as unknown as ProjectDocument['episodeTitles'],
    assets: { byId: byId as unknown as Record<string, ProjectDocument['assets']['byId'][string]> },
  }
}

/** 场景节点的悬空角色/地点引用警告（§11.4）：只记警告，不清除 id。
 * 桶缺失（Rust 兼容默认 settings:{}）按空集合处理，不抛错。 */
function sceneRefWarnings(
  n: StoryNode,
  doc: ProjectDocument,
  warnings: string[],
): void {
  const s = n.data.spec as { characterIds?: string[]; locationId?: string }
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
}

/** 设定集实体的悬空头像资产引用警告（§11.4）：avatarAssetId 在
 * Character 实体上（非节点 spec），指向 assets.byId 中不存在的条目即警告。 */
function characterAvatarWarnings(doc: ProjectDocument, warnings: string[]): void {
  for (const ch of Object.values(doc.settings.characters ?? {})) {
    if (ch.avatarAssetId && !doc.assets?.byId[ch.avatarAssetId]) {
      warnings.push(`角色 ${ch.name}（${ch.id}）的头像引用了不存在的资产 ${ch.avatarAssetId}`)
    }
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

/** 孤儿边判定（§11.3）：端点节点缺失；branch 边绑定的选项已不存在；
 * attach 边句柄非字面量 shots（无法确定性修复）；attach 边端点类型不合法
 * （必须 scene → shot）；剧情流边端点为 shot（§4.2 分镜卡不参与横向剧情流）
 * 同论。句柄可剥离的矛盾形态已在 stripAlienHandles 阶段处理，不在此隔离。 */
function isOrphanEdge(e: StoryEdge, nodesById: Map<string, StoryNode>): boolean {
  const src = nodesById.get(e.source)
  const dst = nodesById.get(e.target)
  if (!src || !dst) return true
  if (e.data.kind === 'attach') {
    if (e.sourceHandle !== SCENE_SHOT_HANDLE) return true
    return src.type !== 'scene' || dst.type !== 'shot'
  }
  // 剧情流端点约束：分镜卡不参与横向剧情流（§4.2）
  if (src.type === 'shot' || dst.type === 'shot') return true
  if (e.data.kind !== 'branch') return false
  if (src.type !== 'branch') return true
  const optionId = branchOptionIdOf(e.sourceHandle)
  const options = (src.data.spec as BranchSpec).options
  return optionId === undefined || !options.some((o) => o.id === optionId)
}

/** 已知 kind 边的确定性句柄剥离（§5）：匿名端口唯一，targetHandle 与
 * sequence 的 sourceHandle 无法绑定真实端口——剥离不改变连接语义，
 * 记录警告而不隔离。未知/非字符串 kind 无法判定变体，直接隔离并警告
 * （绝不为未知 kind 猜测变体）。 */
function stripAlienHandles(e: StoryEdge, warnings: string[]): StoryEdge | null {
  const kind = (e.data as { kind?: unknown }).kind
  if (kind !== 'sequence' && kind !== 'branch' && kind !== 'attach') {
    warnings.push(`已隔离边 ${e.id}：data.kind 未知或非字符串`)
    return null
  }
  const out = { ...e }
  if (out.targetHandle !== undefined) {
    warnings.push(`边 ${e.id} 的 targetHandle 无法绑定匿名端口，已剥离`)
    delete out.targetHandle
  }
  if (kind === 'sequence' && (out as { sourceHandle?: string }).sourceHandle !== undefined) {
    warnings.push(`sequence 边 ${e.id} 的 sourceHandle 无法绑定匿名端口，已剥离`)
    delete (out as { sourceHandle?: string }).sourceHandle
  }
  return out
}

/** 重复节点 id 修复（§11.1 第 3 步）：保留文档序首个，后续同 id 节点重发
 * 本域未占用的新 id 并警告——按 id 的引用（边端点等）本就解析到首见项，
 * 重发节点成为无连线孤儿节点（内容保留，由用户处置），不产生改接。 */
function reissueDuplicateNodeIds(nodes: StoryNode[], warnings: string[]): StoryNode[] {
  const seen = new Set<string>()
  return nodes.map((n) => {
    if (typeof n.id !== 'string' || !n.id || !seen.has(n.id)) {
      if (typeof n.id === 'string' && n.id) seen.add(n.id)
      return n
    }
    let fresh = uid('node')
    while (seen.has(fresh)) fresh = uid('node')
    warnings.push(`节点 id ${n.id} 重复：保留文档序首个，后续节点已重发新 id ${fresh}（引用仍解析到首见节点）`)
    seen.add(fresh)
    return { ...n, id: fresh }
  })
}

/** 已接受剧情流边中 from 是否可达 to（BFS 传递闭包，§4.3 DAG 不变量）。 */
function flowReaches(adj: Map<string, string[]>, from: string, to: string): boolean {
  const seen = new Set([from])
  const queue = [from]
  while (queue.length > 0) {
    const cur = queue.pop() as string
    for (const next of adj.get(cur) ?? []) {
      if (next === to) return true
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return false
}

/** 剧情流成环隔离（§11.1 第 3 步）：候选边按文档序逐边重建剧情流图，
 * 自环（source === target）与加入即闭合回路的 sequence/branch 边按孤儿边
 * 隔离并警告；attach 垂直从属不参与环检测（§4.3）。 */
function isolateCycleEdges(edges: StoryEdge[], warnings: string[]): StoryEdge[] {
  const adj = new Map<string, string[]>()
  const kept: StoryEdge[] = []
  for (const e of edges) {
    if (e.data.kind === 'attach') {
      kept.push(e)
      continue
    }
    if (e.source === e.target) {
      warnings.push(`已隔离自环边 ${e.id}：source 与 target 相同`)
      continue
    }
    if (flowReaches(adj, e.target, e.source)) {
      warnings.push(`已隔离成环边 ${e.id}：加入后剧情流闭合回路（${e.target} 已可达 ${e.source}）`)
      continue
    }
    const list = adj.get(e.source)
    if (list) list.push(e.target)
    else adj.set(e.source, [e.target])
    kept.push(e)
  }
  return kept
}

/** attach 宿主唯一（§5/§11.1 第 3 步）：同一 shot 至多一条入向 attach 边
 * （分集归属与下挂布局的唯一依据）——保留文档序首条，其余按孤儿边隔离并警告。 */
function isolateExtraAttachHosts(edges: StoryEdge[], warnings: string[]): StoryEdge[] {
  const hosted = new Set<string>()
  const kept: StoryEdge[] = []
  for (const e of edges) {
    if (e.data.kind !== 'attach') {
      kept.push(e)
      continue
    }
    if (hosted.has(e.target)) {
      warnings.push(`已隔离多余的 attach 边 ${e.id}：分镜 ${e.target} 已有宿主场景（宿主唯一）`)
      continue
    }
    hosted.add(e.target)
    kept.push(e)
  }
  return kept
}

/** 归一化（§11.1 第 2 步容器校验 → 第 3 步重复节点 id 重发 → 句柄剥离 →
 * §11.3 孤儿边隔离 → 第 3 步成环/attach 宿主唯一隔离 → §11.2 选中态重置 →
 * §11.4 悬空引用标记）。 */
function normalizeDocument(
  raw: Record<string, unknown>,
  env: NormalizeEnv,
): { doc: ProjectDocument; warnings: string[] } {
  const warnings: string[] = []
  const shaped = normalizeContainers(raw, env, warnings)
  const activeNodes = reissueDuplicateNodeIds(shaped.graph.nodes, warnings)
  const nodesById = new Map(activeNodes.map((n) => [n.id, n]))
  const edges = isolateExtraAttachHosts(
    isolateCycleEdges(
      shaped.graph.edges
        .map((e) => stripAlienHandles(e, warnings))
        .filter((e): e is StoryEdge => e !== null)
        .filter((e) => {
          const orphan = isOrphanEdge(e, nodesById)
          if (orphan) warnings.push(`已隔离孤儿边 ${e.id}：端点节点或绑定选项不存在`)
          return !orphan
        }),
      warnings,
    ),
    warnings,
  )
  const nodes = activeNodes.map((n) => {
    collectDanglingRefWarnings(n, shaped, warnings)
    return { ...n, ui: { ...n.ui, selected: false } }
  })
  characterAvatarWarnings(shaped, warnings)
  return { doc: { ...shaped, graph: { ...shaped.graph, nodes, edges } }, warnings }
}

/**
 * 归一化管线入口（§11）：schemaVersion 校验与迁移 → 归一化 → 会话文档。
 * v0 信封（旧扁平格式经 Rust 包装）先走节点字段迁移，再按 v1 解析。
 * env 携带加载路径的受信事实（projectId / 索引名），供元数据修复使用。
 */
export function parseProject(raw: unknown, env: NormalizeEnv = {}): ParseResult {
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
    const env0 = raw as Partial<ProjectDocument> & {
      project?: Partial<ProjectDocument['project']>
      graph?: { nodes?: CanvasNode[]; edges?: Edge[]; viewport?: Viewport }
      settings?: unknown
      episodeTitles?: unknown
    }
    const v0Warnings: string[] = []
    const legacy: ProjectContent = {
      name: env0.project?.name ?? '',
      createdAt: env0.project?.createdAt || undefined,
      nodes: env0.graph?.nodes ?? [],
      edges: env0.graph?.edges ?? [],
      settings: (env0.settings ?? {}) as ProjectContent['settings'],
      episodeTitles: normalizeEpisodeTitles(env0.episodeTitles, v0Warnings),
      viewport: env0.graph?.viewport,
    }
    const migrated = migrateProjectDocument(legacy)
    const doc = serializeProject(rewriteIndexOptionHandles(migrated.doc), env0.project?.id ?? '')
    const { doc: normalized, warnings } = normalizeDocument(
      doc as unknown as Record<string, unknown>,
      env,
    )
    return {
      content: fromDocument(normalized, warnings),
      migrated: true,
      warnings: [...v0Warnings, ...warnings],
    }
  }

  const { doc: normalized, warnings } = normalizeDocument(
    raw as Record<string, unknown>,
    env,
  )
  return { content: fromDocument(normalized, warnings), migrated: false, warnings }
}

/** 落盘文档 → 会话文档（归一化之后调用）。视口/资产桶缺省字段保持缺省：
 * 视口缺省 = 打开时 fitView；资产缺省 = 无资产（透传桶，见 content.ts）。
 * episodeTitles 键值域严格化在此收口（§11.1，对所有版本统一执行）。 */
function fromDocument(doc: ProjectDocument, warnings: string[]): ProjectContent {
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
