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
  type BranchEdge,
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
  if (n.type === 'branch' || n.type === 'shot') {
    // 派生标题节点：不落 meta.label 镜像；分镜卡随宿主场景分集，
    // 不落独立 episodeNo（§3.5）
    const meta = n.type === 'shot' ? { ...passthroughTs } : { ...optionalMeta, ...passthroughTs }
    return {
      ...base,
      type: n.type,
      data: { spec: spec as unknown as BranchSpec & ShotSpec, meta },
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
  /** Rust 加载侧实路径复验（§7.1/§10.5）未通过的资产键：前端无法访问
   * 文件系统，受信根 no-follow 验证的事实由调用方带入，归一化据此隔离
   * 索引条目并标记引用悬空——否则下次保存被保存边界拒收、防抖吞错，
   * 用户编辑永不落盘。 */
  invalidAssetKeys?: readonly string[]
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

/** relatedIds 成员的非法原因（§6 的 {kind,id} 显式成对：kind ∈
 * character/location、id 字符串；(kind,id) 数组内唯一——重复关联会让
 * 反向索引/导航重复列出同一文档）；null 表示通过并登记首见。
 * 空白字符串 id 暂留：可能指向即将重发新键的同桶空白键实体，后续经
 * rewriteBlankKeyReferences 按 kind 改写（第 3 步）；改写后仍空白的项
 * 在那里移除——提前删除会把有效关联连同空白键实体一起误杀。 */
function relatedIdIssue(r: unknown, seen: Set<string>): string | null {
  if (!isPlainObject(r)) return '异型（非普通对象）'
  if (r.kind !== 'character' && r.kind !== 'location') return `kind 未知（${String(r.kind)}）`
  if (typeof r.id !== 'string') return 'id 非字符串'
  const pair = `${r.kind} ${r.id}`
  if (seen.has(pair)) return '与首见项 (kind, id) 重复'
  seen.add(pair)
  return null
}

/** 设定文档 relatedIds 的形状修复（§6/§11.1 第 3 步，与 §9.3 upsert_document
 * 边界同域）：缺失/非数组置空；异型成员、未知 kind、非字符串 id、重复
 * (kind,id) 对（保留首见）逐项移除并警告——空白字符串 id 暂留待空键重发
 * 改写（见 relatedIdIssue）。非法关联若原样进会话会以 typed
 * DocumentEntity 暴露给反向索引/导航，且保存边界只验桶容器、会原样落盘。 */
function normalizeRelatedIds(key: string, entry: Record<string, unknown>, warnings: string[]): void {
  const related = entry.relatedIds
  if (!Array.isArray(related)) {
    warnings.push(`设定文档 ${key} 的 relatedIds 缺失或非数组，已重置为空数组`)
    entry.relatedIds = []
    return
  }
  const seen = new Set<string>()
  const kept = related.filter((r: unknown) => {
    const issue = relatedIdIssue(r, seen)
    if (issue) warnings.push(`设定文档 ${key} 的 relatedIds 成员${issue}，已移除`)
    return issue === null
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
    // 桶成员已经上方过滤为普通对象；title/body 形状与键修复在
    // normalizeEntityShapes/reKeyBlankEntries 与其它桶同款执行
    normalizeRelatedIds(k, v as Record<string, unknown>, warnings)
  }
  return settings
}

/** 桶内单条实体的必填形状（§11.3，与 §9.3 upsert 边界同域）：
 * 返回隔离原因；null 表示通过。documents 按 §6 判别必填 title/body。 */
function entityIsolationReason(
  bucket: 'characters' | 'locations' | 'props' | 'documents',
  entry: Record<string, unknown>,
): string | null {
  if (bucket === 'documents') {
    if (typeof entry.title !== 'string' || typeof entry.body !== 'string') {
      return 'title/body 缺失或非字符串'
    }
    return null
  }
  const name = entry.name
  if (typeof name !== 'string' || !name.trim()) {
    return 'name 缺失、非字符串或空白'
  }
  if (bucket === 'characters' && typeof entry.gradient !== 'string') {
    return 'gradient 缺失或非字符串'
  }
  return null
}

/** 可选字符串字段（bio/note/description/avatarAssetId）存在但类型错误时
 * 剥离该字段并警告，条目保留。 */
function stripWrongTypedOptionalFields(
  bucket: string,
  key: string,
  entry: Record<string, unknown>,
  fields: readonly string[],
  warnings: string[],
): void {
  for (const field of fields) {
    if (entry[field] !== undefined && typeof entry[field] !== 'string') {
      warnings.push(`settings.${bucket} 条目 ${key} 的可选字段 ${field} 非字符串，已剥离`)
      delete entry[field]
    }
  }
}

/** 键控桶空记录键修复（§11.1 第 3 步，记录键非空前置——先于各桶形状校验
 * 与键 id 一致性改写）：空/空白键条目确定性重发本桶未占用的新键，值内 id
 * 随键同步（键是引用解析的权威值）——空身份会与 upsert 边界冲突并留下无法
 * 更新的实体/空 React key。返回「空键 → 新键」映射供同桶引用改写：JSON 键
 * 唯一，同一空键串在每桶至多出现一次，映射恒明确。 */
function reKeyBlankEntries(
  record: Record<string, Record<string, unknown>>,
  bucketLabel: string,
  prefix: string,
  warnings: string[],
): Map<string, string> {
  const remap = new Map<string, string>()
  for (const key of Object.keys(record)) {
    if (key.trim()) continue
    let fresh = uid(prefix)
    while (fresh in record) fresh = uid(prefix)
    const entry = record[key]
    delete record[key]
    record[fresh] = entry
    entry.id = fresh
    remap.set(key, fresh)
    warnings.push(`${bucketLabel} 存在空记录键，已重发新键 ${fresh}（值内 id 随键同步）`)
  }
  return remap
}

/** 单值引用改写：命中「空键 → 新键」映射则返回新 id 并警告，否则原样返回。 */
function rewriteRef(
  map: Map<string, string>,
  value: unknown,
  describe: string,
  warnings: string[],
): unknown {
  if (typeof value !== 'string') return value
  const mapped = map.get(value)
  if (mapped === undefined) return value
  warnings.push(`${describe} 指向已重发的空记录键，已改写为新 id ${mapped}`)
  return mapped
}

/** 各桶「空键 → 新键」映射集合：characters/locations 来自设定桶，
 * assets 来自资产索引。 */
interface BlankKeyRemaps {
  characters: Map<string, string>
  locations: Map<string, string>
  assets: Map<string, string>
}

/** 场景节点的空键引用改写：characterIds 数组项与 locationId。 */
function rewriteSceneBlankRefs(
  nid: string,
  spec: Record<string, unknown>,
  remaps: BlankKeyRemaps,
  warnings: string[],
): void {
  if (Array.isArray(spec.characterIds)) {
    spec.characterIds = (spec.characterIds as unknown[]).map((cid, i) =>
      rewriteRef(remaps.characters, cid, `节点 ${nid} 的 characterIds[${i}]`, warnings),
    )
  }
  if ('locationId' in spec) {
    spec.locationId = rewriteRef(remaps.locations, spec.locationId, `节点 ${nid} 的 locationId`, warnings)
  }
}

/** 对白节点的空键引用改写：各行 speaker 指向 characters 桶。 */
function rewriteDialogueBlankRefs(
  nid: string,
  spec: Record<string, unknown>,
  characters: Map<string, string>,
  warnings: string[],
): void {
  if (!Array.isArray(spec.lines)) return
  for (const [i, line] of (spec.lines as unknown[]).entries()) {
    if (!isPlainObject(line) || !('speaker' in line)) continue
    line.speaker = rewriteRef(characters, line.speaker, `节点 ${nid} 的对白行 ${i} speaker`, warnings)
  }
}

/** 分镜节点的空键引用改写（§11.1 六十四轮）：assetId 只按资产索引解析——
 * 引用位的唯一命名空间是 assets.byId，不再按 kind 分派设定集桶。 */
function rewriteShotBlankRefs(
  nid: string,
  spec: Record<string, unknown>,
  remaps: BlankKeyRemaps,
  warnings: string[],
): void {
  if (!Array.isArray(spec.refs)) return
  for (const ref of spec.refs as unknown[]) {
    if (!isPlainObject(ref) || !('assetId' in ref)) continue
    ref.assetId = rewriteRef(remaps.assets, ref.assetId, `节点 ${nid} 的分镜引用 ${String(ref.id)}`, warnings)
  }
}

/** 设定文档 relatedIds 的空键改写（§11.1 第 3 步，六十六轮）：按 kind
 * 对应桶改写（禁止跨命名空间）；改写后仍指向空白 id 且无对应重发的项
 * 移除并警告。 */
function rewriteDocumentBlankRefs(
  settings: Record<string, Record<string, unknown>>,
  remaps: BlankKeyRemaps,
  warnings: string[],
): void {
  for (const [key, doc] of Object.entries(settings.documents) as [string, Record<string, unknown>][]) {
    if (!Array.isArray(doc.relatedIds)) continue
    doc.relatedIds = rewrittenDocumentRelations(key, doc.relatedIds as unknown[], remaps, warnings)
  }
}

/** 单个设定文档的 relatedIds 空键改写：返回改写并清理后的成员列表。 */
function rewrittenDocumentRelations(
  key: string,
  related: unknown[],
  remaps: BlankKeyRemaps,
  warnings: string[],
): unknown[] {
  const kept: unknown[] = []
  for (const r of related) {
    if (!isPlainObject(r) || (r.kind !== 'character' && r.kind !== 'location')) continue
    const map = r.kind === 'character' ? remaps.characters : remaps.locations
    if (typeof r.id === 'string' && map.has(r.id)) r.id = map.get(r.id) as string
    if (typeof r.id === 'string' && r.id.trim()) kept.push(r)
    else warnings.push(`设定文档 ${key} 的 relatedIds 项指向空白 id 且无对应重发，已移除`)
  }
  return kept
}

/** 空键重发后的同桶引用改写（§11.1 第 3 步，六十六轮）：指向空串的引用
 * 字段（场景 characterIds/locationId、对白 speaker、分镜 assetId、角色
 * avatarAssetId、设定文档 relatedIds 按 kind 对应桶）随重发改写到新 id
 * 而非变悬空——脏写引用侧同样可出现空串。 */
function rewriteBlankKeyReferences(
  nodes: StoryNode[],
  settings: Record<string, Record<string, unknown>>,
  remaps: BlankKeyRemaps,
  warnings: string[],
): void {
  for (const n of nodes) {
    const spec = n.data.spec as unknown as Record<string, unknown>
    if (n.type === 'scene') rewriteSceneBlankRefs(n.id, spec, remaps, warnings)
    if (n.type === 'dialogue') rewriteDialogueBlankRefs(n.id, spec, remaps.characters, warnings)
    if (n.type === 'shot') rewriteShotBlankRefs(n.id, spec, remaps, warnings)
  }
  for (const [key, ch] of Object.entries(settings.characters) as [string, Record<string, unknown>][]) {
    if (!('avatarAssetId' in ch)) continue
    ch.avatarAssetId = rewriteRef(remaps.assets, ch.avatarAssetId, `角色 ${key} 的 avatarAssetId`, warnings)
  }
  rewriteDocumentBlankRefs(settings, remaps, warnings)
}

/** 设定集实体形状校验（§11.3）：必填字段无法机械修复的条目从桶中隔离并警告
 * （否则 name: null 之类的值交付画布后，头像渲染的 trim 在运行期崩溃），
 * 既有引用按 §8.2.3 悬空标记；记录键为权威 id，内嵌 id 缺失或漂移以键改写
 * （与 assets.byId 同域）。documents 桶按 §6 判别必填 title/body。 */
function normalizeEntityShapes(
  settings: Record<string, Record<string, unknown>>,
  warnings: string[],
): void {
  const optionalStringFields: Record<string, string[]> = {
    characters: ['bio', 'avatarAssetId'],
    locations: ['note'],
    props: ['description'],
    documents: [],
  }
  for (const bucket of ['characters', 'locations', 'props', 'documents'] as const) {
    const entries = settings[bucket]
    // 桶成员已经 plainObjectEntries/成员过滤保证为普通对象
    for (const [key, entry] of Object.entries(entries) as [string, Record<string, unknown>][]) {
      const reason = entityIsolationReason(bucket, entry)
      if (reason) {
        const label = bucket === 'characters' ? `角色 ${key}` : `settings.${bucket} 条目 ${key}`
        warnings.push(`${label} 的 ${reason}，已隔离`)
        delete entries[key]
        continue
      }
      // 记录键为权威 id（与 assets.byId 同域）：内嵌 id 缺失或漂移以键改写——
      // 否则悬空引用判定按键解析而 fromDocSettings 暴露内嵌值，引用被误标
      // 删除，下次保存又把实体重键为漂移值（§8.2.3）
      if (entry.id !== key) {
        warnings.push(
          `settings.${bucket} 条目 ${key} 的内嵌 id 缺失或与记录键不一致，已以记录键为准改写`,
        )
        entry.id = key
      }
      stripWrongTypedOptionalFields(bucket, key, entry, optionalStringFields[bucket], warnings)
    }
  }
}

/** RFC 7230 token（与 Rust is_mime_token 同域）：MIME 类型的单个组成部分。 */
function isMimeToken(s: string): boolean {
  return /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(s)
}

/** 规范 MIME（§7.1，与 Rust is_canonical_mime 同域）：恰好两个 token 以 / 分隔；
 * 调用方先完成大小写/空白规范化。 */
function isCanonicalMime(s: string): boolean {
  const parts = s.split('/')
  return parts.length === 2 && isMimeToken(parts[0]) && isMimeToken(parts[1])
}

/** relPath 词法校验（§7.1，与 Rust is_valid_asset_rel_path 同域）：纯相对路径，
 * 首段固定 assets、组件不含空段/`.`/`..`——解析目标必须位于项目资产子目录内
 * （空串经首段检查一并拒绝）。 */
function isLexicalAssetRelPath(p: string): boolean {
  if (p.includes('\\') || p.startsWith('/') || p !== p.trim()) return false
  const comps = p.split('/')
  return (
    comps[0] === 'assets' &&
    comps.length >= 2 &&
    comps.slice(1).every((c) => c !== '' && c !== '.' && c !== '..')
  )
}

/** 严格 ISO 8601（与 Rust 保存边界 is_valid_iso8601 同域）：
 * `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)`，含字段取值范围与闰年规则——
 * Date.parse 的宽松超集（如 "2026-08-01"）不放行，否则下一次保存被
 * Rust 边界整份拒绝。 */
function isStrictIso8601(s: string): boolean {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(s)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12) return false
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) return false
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  if (day < 1 || day > daysInMonth) return false
  if (m[7] !== 'Z') {
    const offset = m[7].slice(1).split(':')
    if (Number(offset[0]) > 23 || Number(offset[1]) > 59) return false
  }
  return true
}

/** 单条资产条目的逐字段形状校验（§11.3）：返回隔离原因；null 表示通过。
 * MIME 的合法性按已规范化（trim + 小写）后的值判定。 */
function assetIsolationReason(entry: Record<string, unknown>): string | null {
  if (typeof entry.relPath !== 'string' || !isLexicalAssetRelPath(entry.relPath)) {
    return 'relPath 缺失、非字符串或越出资产子目录'
  }
  if (typeof entry.mime !== 'string' || !isCanonicalMime(entry.mime.trim().toLowerCase())) {
    return 'mime 缺失或非规范形式'
  }
  if (entry.source !== 'upload' && entry.source !== 'generated') {
    return 'source 非法'
  }
  if (typeof entry.createdAt !== 'string' || !isStrictIso8601(entry.createdAt)) {
    return 'createdAt 不是严格 ISO 8601 时间戳'
  }
  return null
}

/** assets.byId 完整 AssetRef 形状校验（§11.3，Rust 保存边界 §10.5 的加载侧
 * 对等）：记录键为权威 id——内嵌 id 缺失或漂移以键改写；relPath 词法、规范
 * MIME（合法大小写/首尾空白规范化后保留）、source 枚举、严格 ISO 8601
 * createdAt 任一非法即从活动索引隔离并警告——脏条目若原样进会话，下一次
 * 保存被 Rust 边界整份拒绝、用户编辑无法持久化；被隔离条目的引用按
 * §8.2.3 悬空展示。真实路径包含判定归 Rust load_project（§7.1 分层执行）。 */
function normalizeAssetRecords(
  byId: Record<string, Record<string, unknown>>,
  warnings: string[],
  invalidKeys: ReadonlySet<string>,
): void {
  for (const [key, entry] of Object.entries(byId)) {
    if (invalidKeys.has(key)) {
      warnings.push(`资产 ${key} 的媒体文件实路径复验未通过（缺失/符号链接/逃逸），已从索引隔离`)
      delete byId[key]
      continue
    }
    if (entry.id !== key) {
      warnings.push(`资产 ${key} 的内嵌 id 缺失或与记录键不一致，已以记录键为准改写`)
      entry.id = key
    }
    const reason = assetIsolationReason(entry)
    if (reason) {
      warnings.push(`资产 ${key} 的 ${reason}，已隔离`)
      delete byId[key]
      continue
    }
    const mime = (entry.mime as string).trim().toLowerCase()
    if (mime !== entry.mime) {
      warnings.push(`资产 ${key} 的 mime 已规范化为 ${mime}`)
      entry.mime = mime
    }
  }
}

/** 桶成员身份快照（六十四轮 targetId 兼容的「修复前后的身份」判定）：记录
 * 每个记录键与其一致性改写前的内嵌 id（字符串时）——须在键/id 改写前捕获；
 * 判定时再按桶当前成员过滤，已被隔离的条目不参与命中。 */
interface IdentitySnapshot {
  key: string
  ids: Set<string>
}

/** 捕获桶内每条记录的身份集合：最终记录键 + 当前内嵌 id（字符串时）。 */
function identitySnapshot(record: Record<string, Record<string, unknown>>): IdentitySnapshot[] {
  return Object.entries(record).map(([key, entry]) => {
    const ids = new Set<string>([key])
    if (typeof entry.id === 'string' && entry.id.trim()) ids.add(entry.id)
    return { key, ids }
  })
}
/** targetId 兼容判定的输入面：修复后的设定桶/资产索引（当前成员身份）、
 * 修复前身份快照与资产空键重发映射。 */
interface LegacyTargetIdCtx {
  characters: Record<string, unknown>
  characterIds0: IdentitySnapshot[]
  locations: Record<string, unknown>
  locationIds0: IdentitySnapshot[]
  byId: Record<string, Record<string, unknown>>
  assetIds0: IdentitySnapshot[]
  assetRemap: Map<string, string>
}

/** 旧值是否命中对应设定桶实体（修复前后的身份，已隔离实体不计）。 */
function legacyEntityHit(value: string, bucket: Record<string, unknown>, snap: IdentitySnapshot[]): boolean {
  return snap.some((e) => e.key in bucket && e.ids.has(value))
}

/** 旧值按资产键修复前后的身份唯一命中活动 image/* 资产时返回最终记录键；
 * 零命中、多命中（歧义）或命中资产已被隔离/家族不符时返回 null。 */
function legacyImageAssetKey(value: string, ctx: LegacyTargetIdCtx): string | null {
  const hits = ctx.assetIds0.filter((a) => {
    const asset = ctx.byId[a.key]
    return asset !== undefined && typeof asset.mime === 'string' && asset.mime.startsWith('image/') && a.ids.has(value)
  })
  return hits.length === 1 ? hits[0].key : null
}

/** 单条 ref 的旧 targetId 兼容转换：成功改名 assetId 并删除 targetId；
 * 歧义/异型时隔离该 ref（返回空数组）并警告；不带 targetId 或 kind 未知的
 * 成员原样交给当前联合校验。 */
function compatOneShotTargetId(
  nid: string,
  ref: unknown,
  ctx: LegacyTargetIdCtx,
  warnings: string[],
): unknown[] {
  if (!isPlainObject(ref) || !('targetId' in ref)) return [ref]
  const isolate = (reason: string): unknown[] => {
    warnings.push(`节点 ${nid} 的分镜引用携带旧字段 targetId（${reason}），已隔离该引用`)
    return []
  }
  if ('assetId' in ref || 'label' in ref) return isolate('与 assetId/label 并存，歧义')
  const value = ref.targetId
  if (typeof value !== 'string' || !value.trim()) return isolate('旧值不是合法字符串 id')
  if (ref.kind === 'audio') {
    ref.assetId = ctx.assetRemap.get(value) ?? value
    delete ref.targetId
    return [ref]
  }
  if (ref.kind !== 'character' && ref.kind !== 'location') return [ref]
  const bucket = ref.kind === 'character' ? ctx.characters : ctx.locations
  const snap = ref.kind === 'character' ? ctx.characterIds0 : ctx.locationIds0
  const assetKey = legacyImageAssetKey(value, ctx)
  if (assetKey !== null && !legacyEntityHit(value, bucket, snap)) {
    ref.assetId = assetKey
    delete ref.targetId
    return [ref]
  }
  return isolate('无法无歧义解析为唯一活动 image/* 资产')
}

/** ShotRef 旧草案 targetId 的无歧义兼容子步骤（§11.1 六十四轮，本步节点
 * 联合校验的一部分、先于 refs 成员形状筛选）：kind === 'audio' 的旧值依原
 * 契约视为项目资产 id（随资产空键重发映射）改名 assetId，目标缺失保留为
 * 悬空引用；kind === 'character' | 'location' 仅当旧值按资产键修复前后的
 * 身份唯一命中活动 image/* 项目资产、且按对应设定桶修复前后的身份均未命中
 * 实体时才改名，否则隔离并警告。成功转换后删除 targetId；角色/地点实体 id
 * 不得当成资产 id，也不隐式追随 Character.avatarAssetId。只处理可遍历的
 * shot 节点（data/spec 为普通对象且 refs 为数组），其余形态由节点校验收口。 */
function compatLegacyShotTargetIds(
  nodesRaw: unknown[],
  ctx: LegacyTargetIdCtx,
  warnings: string[],
): void {
  for (const member of nodesRaw) {
    if (!isPlainObject(member) || member.type !== 'shot') continue
    if (!isPlainObject(member.data) || !isPlainObject(member.data.spec)) continue
    const spec = member.data.spec
    if (!Array.isArray(spec.refs)) continue
    const nid = typeof member.id === 'string' ? member.id : '未知'
    spec.refs = (spec.refs as unknown[]).flatMap((ref) => compatOneShotTargetId(nid, ref, ctx, warnings))
  }
}

/** 对白行成员形状（§4.2 DialogueLine）：判别字段 kind ∈ line/action 且
 * text 必填字符串——text 异型的行进会话后会被 DialogueNode 当 React 子节点
 * 渲染而崩溃，一行坏行不应阻挡整个项目画布打开。id 缺失不致命（列表 key
 * 退化但不崩溃），旧格式的 id 回填由迁移链（legacy.ts）负责，不在此判别。 */
function isDialogueLineShape(item: unknown): boolean {
  if (!isPlainObject(item)) return false
  if (item.kind !== 'line' && item.kind !== 'action') return false
  return typeof item.text === 'string'
}

const NODE_TYPES = new Set(['scene', 'beat', 'dialogue', 'branch', 'shot'])

/** 名称型节点（§4.1 LabeledMeta）：meta.label 必填。 */
const LABELED_TYPES = new Set(['scene', 'beat', 'dialogue'])

/** spec 类型相关必填标量（§4.2 判别联合）：编号 sceneNo/shotNo 可顺位重发、
 * 必填列表可确定性置空，均不在此判定；此处只收无法机械修复的标量。 */
const REQUIRED_SCALARS: Record<string, Record<string, 'string' | 'boolean'>> = {
  scene: { interior: 'boolean', synopsis: 'string' },
  beat: { tone: 'string' },
  branch: { prompt: 'string' },
  shot: { size: 'string', picture: 'string', prompt: 'string' },
}

/** never 禁写 meta 字段剥离（§4.1 DerivedMeta/ShotMeta）：branch/shot 不落
 * label 镜像；分镜卡随宿主场景分集，无独立 episodeNo。 */
function stripForbiddenMeta(
  type: string,
  meta: Record<string, unknown>,
  nid: string,
  warnings: string[],
): void {
  if ((type === 'branch' || type === 'shot') && 'label' in meta) {
    warnings.push(`节点 ${nid} 携带 never 禁写的 meta.label，已剥离`)
    delete meta.label
  }
  if (type === 'shot' && 'episodeNo' in meta) {
    warnings.push(`分镜卡 ${nid} 携带 never 禁写的 meta.episodeNo（随宿主场景分集），已剥离`)
    delete meta.episodeNo
  }
}

/** meta.episodeNo 值域（§4.1/§9.3 同域：安全整数且 > 0）：非法删除该字段
 * 回退未分集，不阻断加载。 */
function normalizeEpisodeNo(meta: Record<string, unknown>, nid: string, warnings: string[]): void {
  if (!('episodeNo' in meta)) return
  const ep = meta.episodeNo
  if (typeof ep !== 'number' || !Number.isSafeInteger(ep) || ep <= 0) {
    warnings.push(`节点 ${nid} 的 meta.episodeNo 非法，已删除（回退未分集）`)
    delete meta.episodeNo
  }
}

/** 场景自由文本字段的就地修复与形态校验（§4.2/§11.1，SceneNode 渲染安全）：
 * time 在存储契约中为可选缺省，但运行态 SceneNodeData.time 是必填字符串且
 * SceneNode 无条件渲染——缺失确定性置空串并警告；非字符串值（形态错位，如
 * time: {}）会被当成 React 子节点渲染而崩溃，返回隔离原因。可选 weather 的
 * 非字符串值是真值，同样会被条件渲染成 React 子节点——剥离该字段并警告，
 * 节点本体保留。返回 null 表示通过。 */
function normalizeSceneTextFields(
  spec: Record<string, unknown>,
  nid: string,
  warnings: string[],
): string | null {
  if ('weather' in spec && typeof spec.weather !== 'string') {
    warnings.push(`节点 ${nid} 的 spec.weather 非字符串，已剥离`)
    delete spec.weather
  }
  if (!('time' in spec)) {
    spec.time = ''
    warnings.push(`节点 ${nid} 的 spec.time 缺失，已置空串`)
    return null
  }
  if (typeof spec.time !== 'string') return 'spec.time 类型错误（spec 形态错位）'
  return null
}

/** 节点判别联合形状校验（§11.1 第 3 步节点校验细则——§4.1 联合在加载路径的
 * 对等兜底，JSON 边界已擦除 TS 类型）：never 禁写字段剥离、episodeNo 非法
 * 删除为就地修复；未知类型、spec 必填标量缺失/异型（形态错位，如 beat 的
 * tone 为对象——交付画布后被当 React 子节点渲染而崩溃）、名称型节点缺必填
 * meta.label 等无法机械修复的形态返回隔离原因；null 表示通过。 */
function nodeDiscriminantError(
  member: Record<string, unknown>,
  nid: string,
  warnings: string[],
): string | null {
  const type = member.type
  const data = member.data as { spec: Record<string, unknown>; meta: Record<string, unknown> }
  if (typeof type !== 'string' || !NODE_TYPES.has(type)) {
    return `未知节点类型 ${String(type)}`
  }
  stripForbiddenMeta(type, data.meta, nid, warnings)
  if (LABELED_TYPES.has(type) && typeof data.meta.label !== 'string') {
    return '缺必填 meta.label'
  }
  normalizeEpisodeNo(data.meta, nid, warnings)
  if (type === 'scene') {
    const textIssue = normalizeSceneTextFields(data.spec, nid, warnings)
    if (textIssue) return textIssue
  }
  for (const [field, kind] of Object.entries(REQUIRED_SCALARS[type] ?? {})) {
    if (typeof data.spec[field] !== kind) return `spec.${field} 缺失或类型错误（spec 形态错位）`
  }
  return null
}

/** 键控列表成员 id 的非法原因（§8.1 共同值域：非空字符串）。 */
function keyedIdIssue(id: unknown): string {
  if (typeof id !== 'string') return '非字符串'
  if (!id.trim()) return '缺失或空白'
  return '重复'
}

const KEYED_LIST_PREFIX: Record<string, string> = { lines: 'line', options: 'opt', refs: 'ref' }

/** 键控列表成员 id 修复（§11.1 第 3 步：id 非空且数组内唯一——重复 id 会令
 * 删除/重排 reconcile 到错误项，重复选项 id 还让 removedOptionHandles 识别
 * 失效、把既有连线静默改接到剩余同 id 选项）：缺失/非字符串/空白/重复 id
 * 均重发本列表未占用的新 id（重复保留首见项）。返回 branch 选项的「空 id
 * 原值 → 新 id」明确映射：同一空白原值在列表中仅出现一次时映射唯一，供
 * 引出边 option- 句柄同步改写；多次出现即歧义不建映射，指向它的连线随
 * 重发失效、按孤儿边隔离。 */
function normalizeKeyedListIds(
  list: unknown[],
  listKey: string,
  nid: string,
  warnings: string[],
): Map<string, string> {
  const blankCounts = new Map<string, number>()
  for (const item of list) {
    const id = (item as Record<string, unknown>).id
    if (typeof id === 'string' && !id.trim()) {
      blankCounts.set(id, (blankCounts.get(id) ?? 0) + 1)
    }
  }
  const seen = new Set<string>()
  const remap = new Map<string, string>()
  for (const item of list) {
    const rec = item as Record<string, unknown>
    const id = rec.id
    if (typeof id === 'string' && id.trim() && !seen.has(id)) {
      seen.add(id)
      continue
    }
    let fresh = uid(KEYED_LIST_PREFIX[listKey])
    while (seen.has(fresh)) fresh = uid(KEYED_LIST_PREFIX[listKey])
    seen.add(fresh)
    // 非字符串 id 不为它建句柄映射：字符串句柄不得猜测为某个非字符串选项 id
    if (typeof id === 'string' && !id.trim() && blankCounts.get(id) === 1) remap.set(id, fresh)
    warnings.push(`节点 ${nid} 的 ${listKey} 成员 id ${keyedIdIssue(id)}，已重发新 id ${fresh}`)
    rec.id = fresh
  }
  return remap
}

/** 分支选项成员形状（§4.2 BranchOption）：label 必填字符串——对象形态的
 * label 进会话后会被 BranchNode 当 React 子节点渲染而崩溃；id 缺失/空白
 * 不致命，由键控列表 id 修复兜底，不在此判别。 */
function isBranchOptionShape(item: unknown): boolean {
  return isPlainObject(item) && typeof item.label === 'string'
}

/** 分镜引用位成员形状（§4.2 ShotRef 判别联合，六十四轮）：kind ∈
 * character/location/audio，且 assetId（引用位，字符串）与 label（自由位，
 * 字符串）恰居其一——两落即镜像字段（禁止），两缺无法判位，均无法机械修复；
 * 对象形态 label 会被 ShotNode 当 React 子节点渲染而崩溃。空白串 assetId
 * 在此放行，由随后的资产空键重发改写兜底（§11.1 第 3 步）；旧草案 targetId
 * 已由兼容子步骤先行转换或隔离，到达此处即异型。 */
function isShotRefShape(item: unknown): boolean {
  if (!isPlainObject(item)) return false
  if (item.kind !== 'character' && item.kind !== 'location' && item.kind !== 'audio') return false
  if ('assetId' in item && 'label' in item) return false
  const hasAsset = typeof item.assetId === 'string'
  const hasLabel = typeof item.label === 'string'
  return hasAsset !== hasLabel
}

/** 必填列表成员形状判别（§4.2 完整联合）：characterIds 为字符串引用；lines
 * 需 DialogueLine 判别值与必填字段；options/refs 需 BranchOption/ShotRef 的
 * 类型相关字段。无法机械修复的异型成员移除，指向被移除选项的连线由孤儿边
 * 规则收口。 */
function listMemberShapeOk(listKey: string, item: unknown): boolean {
  if (listKey === 'characterIds') return typeof item === 'string'
  if (listKey === 'lines') return isDialogueLineShape(item)
  if (listKey === 'options') return isBranchOptionShape(item)
  if (listKey === 'refs') return isShotRefShape(item)
  return isPlainObject(item)
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
    const ok = listMemberShapeOk(listKey, item)
    if (!ok) warnings.push(`节点 ${nid} 的 spec.${listKey} 含异型成员，已移除`)
    return ok
  })
  if (kept.length !== list.length) spec[listKey] = kept
}

/** 键控列表 id 修复的分发（§11.1 第 3 步）：dialogue.lines / branch.options /
 * shot.refs 三处键控列表逐表修复；branch 空选项 id 的明确句柄映射记入
 * optionIdRemap（以节点 id 为键，首个记录生效），供归一化末段的引出边
 * option- 句柄改写。 */
function repairKeyedListIds(
  member: Record<string, unknown>,
  spec: Record<string, unknown>,
  nid: string,
  warnings: string[],
  optionIdRemap: Map<string, Map<string, string>>,
): void {
  const listKey = REQUIRED_LISTS[member.type as string]
  if (listKey !== 'lines' && listKey !== 'options' && listKey !== 'refs') return
  const remap = normalizeKeyedListIds(spec[listKey] as unknown[], listKey, nid, warnings)
  if (
    listKey === 'options' &&
    remap.size > 0 &&
    typeof member.id === 'string' &&
    member.id &&
    !optionIdRemap.has(member.id)
  ) {
    optionIdRemap.set(member.id, remap)
  }
}

/** 可选布局数值字段归一化（§4.1/§11.1 节点校验细则，与 §9.3 create_node
 * 边界同域）：size 存在时须为普通对象且 width/height 为正有限数，zIndex
 * 存在时须为有限数——非法即剥离该字段并警告（节点本体保留，回退默认尺寸/
 * 层级），合法字段双向保留，不随打开-保存丢失。 */
function normalizeLayoutOptionals(layout: Record<string, unknown>, nid: string, warnings: string[]): void {
  if ('size' in layout) {
    const size = layout.size
    const w = isPlainObject(size) ? size.width : undefined
    const h = isPlainObject(size) ? size.height : undefined
    const ok =
      typeof w === 'number' && Number.isFinite(w) && w > 0 &&
      typeof h === 'number' && Number.isFinite(h) && h > 0
    if (!ok) {
      warnings.push(`节点 ${nid} 的 layout.size 非法（须为普通对象且 width/height 为正有限数），已剥离`)
      delete layout.size
    }
  }
  if ('zIndex' in layout && (typeof layout.zIndex !== 'number' || !Number.isFinite(layout.zIndex))) {
    warnings.push(`节点 ${nid} 的 layout.zIndex 非法（须为有限数），已剥离`)
    delete layout.zIndex
  }
}

/** 单个节点的成员形状校验与机械修复；嵌套容器（data/spec/meta/layout +
 * position 坐标）或判别联合形状（§4.1/§4.2）无法机械修复时隔离该节点
 * （返回 null）。 */
function normalizeNode(
  member: unknown,
  warnings: string[],
  optionIdRemap: Map<string, Map<string, string>>,
): StoryNode | null {
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
  normalizeLayoutOptionals(layout, nid, warnings)
  normalizeRequiredList(data.spec, member.type, nid, warnings)
  const shapeError = nodeDiscriminantError(member, nid, warnings)
  if (shapeError) {
    warnings.push(`节点 ${nid} 的判别形状非法（${shapeError}），已隔离`)
    return null
  }
  repairKeyedListIds(member, data.spec, nid, warnings, optionIdRemap)
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

/** 项目必填元数据修复：受信 id 覆盖、名称回退链、时间戳修复、非字符串描述剥离。
 * 时间戳与 Rust 保存边界 is_valid_iso8601 同域：Date.parse 的宽松超集（纯日期、
 * 无显式时区）不放行——此类值原样进会话后会被 serializeProject 复用，下一次
 * save_project 整份拒绝；严格合法的偏移/精度变体确定性规范化为 UTC
 * toISOString 并警告（与 §7.1 AssetRef 时间戳规范化同口径）。 */
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
  /** 单个时间戳字段修复：严格合法则规范化输出，否则回退并警告。 */
  const repairTimestamp = (v: unknown, label: string, fallback: string, fallbackReason: string): string => {
    if (typeof v === 'string' && isStrictIso8601(v)) {
      const canon = new Date(v).toISOString()
      if (canon !== v) {
        warnings.push(`project.${label} 是合法的偏移/精度变体，已确定性规范化为 UTC ISO 8601`)
      }
      return canon
    }
    warnings.push(`project.${label} 不是严格 ISO 8601 时间戳，${fallbackReason}`)
    return fallback
  }
  const updatedAt = repairTimestamp(
    projectRaw.updatedAt,
    'updatedAt',
    new Date().toISOString(),
    '已取本次加载时刻',
  )
  const createdAt = repairTimestamp(projectRaw.createdAt, 'createdAt', updatedAt, '已采用修复后的 updatedAt')
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

/** 场景/分镜编号顺位重发（§4.2 sceneNo/shotNo 值域：正的安全整数）：编号
 * 非法（非数、非整数、≤ 0、越界）时按文档序取本类型内最小未占用正整数
 * 并警告——编号仅作展示序号，重发不触碰任何引用；合法编号保留，包括重复。 */
function renumberSeqFields(nodes: StoryNode[], warnings: string[]): void {
  const used: Record<'scene' | 'shot', Set<number>> = { scene: new Set(), shot: new Set() }
  for (const n of nodes) {
    if (n.type !== 'scene' && n.type !== 'shot') continue
    const key = n.type === 'scene' ? 'sceneNo' : 'shotNo'
    const spec = n.data.spec as unknown as Record<string, unknown>
    const cur = spec[key]
    if (typeof cur === 'number' && Number.isSafeInteger(cur) && cur > 0) {
      used[n.type].add(cur)
      continue
    }
    let next = 1
    while (used[n.type].has(next)) next += 1
    used[n.type].add(next)
    spec[key] = next
    warnings.push(`节点 ${n.id} 的 spec.${key} 非法（须为正的安全整数），已按文档序顺位重发为 ${next}`)
  }
}

/** §11.1 第 2 步容器级形状校验（先于一切逐项规则；父容器先于子容器）：
 * 异型父/子容器重置为可遍历空容器，非普通对象成员过滤，节点嵌套容器
 * （data/spec/meta/layout + position 坐标）与判别联合形状（§4.1/§4.2）
 * 无法机械修复时隔离该节点，项目必填元数据补齐（受信 id 覆盖、名称回退链、
 * 时间戳修复），节点 ui 默认值补齐，键控桶空记录键重发与同桶引用改写、
 * 键控列表成员 id 重发与编号顺位重发；分镜 refs 的旧草案 targetId 兼容
 * 子步骤（六十四轮）在节点联合校验前按资产命名空间无歧义转换或隔离。
 * 修复而非拒绝：均记录警告，单个脏字段不阻断加载（§8.2.4）。
 * 返回的 optionIdRemap 携带 branch 空选项 id 的明确句柄映射（节点 id →
 * 原空 id → 新 id），供归一化末段的引出边 option- 句柄同步改写。 */
function normalizeContainers(
  raw: Record<string, unknown>,
  env: NormalizeEnv,
  warnings: string[],
): { doc: ProjectDocument; optionIdRemap: Map<string, Map<string, string>> } {
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

  // 成员过滤 + 嵌套容器修复；空记录键重发先于形状校验与键 id 一致性改写
  // （§11.1 第 3 步记录键非空前置），引用改写待节点就位后统一执行
  const settings = normalizeSettingsBuckets(settingsRaw, warnings)
  const byId = plainObjectEntries(assetsRaw.byId, 'assets.byId', warnings)
  // 桶成员已经 plainObjectEntries 过滤为普通对象
  const entityBucket = (bucket: string) =>
    settings[bucket] as Record<string, Record<string, unknown>>
  const blankRemaps: BlankKeyRemaps = {
    characters: reKeyBlankEntries(entityBucket('characters'), 'settings.characters', 'ch', warnings),
    locations: reKeyBlankEntries(entityBucket('locations'), 'settings.locations', 'loc', warnings),
    assets: reKeyBlankEntries(
      byId as Record<string, Record<string, unknown>>,
      'assets.byId',
      'asset',
      warnings,
    ),
  }
  // props/documents 桶无节点引用面，仅重发空键保证身份可用
  reKeyBlankEntries(entityBucket('props'), 'settings.props', 'prop', warnings)
  reKeyBlankEntries(entityBucket('documents'), 'settings.documents', 'doc', warnings)
  // 六十四轮 targetId 兼容的「修复前身份」快照：须在键/id 一致性改写前捕获
  const characterIds0 = identitySnapshot(entityBucket('characters'))
  const locationIds0 = identitySnapshot(entityBucket('locations'))
  const assetIds0 = identitySnapshot(byId as Record<string, Record<string, unknown>>)
  normalizeEntityShapes(settings, warnings)
  // plainObjectEntries 已过滤为普通对象成员；实路径不可验证键经空键重发
  // 映射对齐（重发换键不改变媒体文件的事实）
  const invalidAssets = new Set(
    (env.invalidAssetKeys ?? []).map((k) => blankRemaps.assets.get(k) ?? k),
  )
  normalizeAssetRecords(byId as Record<string, Record<string, unknown>>, warnings, invalidAssets)
  // 旧草案 targetId 兼容：先于节点联合校验（refs 成员形状筛选只认当前联合）
  compatLegacyShotTargetIds(
    nodesRaw,
    {
      characters: entityBucket('characters'),
      characterIds0,
      locations: entityBucket('locations'),
      locationIds0,
      byId: byId as Record<string, Record<string, unknown>>,
      assetIds0,
      assetRemap: blankRemaps.assets,
    },
    warnings,
  )
  const titlesRaw = containerOf(raw.episodeTitles, 'episodeTitles 非普通键值对象，已重置为空 Record')
  const optionIdRemap = new Map<string, Map<string, string>>()
  const nodes: StoryNode[] = []
  for (const member of nodesRaw) {
    const node = normalizeNode(member, warnings, optionIdRemap)
    if (node) nodes.push(node)
  }
  renumberSeqFields(nodes, warnings)
  rewriteBlankKeyReferences(nodes, settings, blankRemaps, warnings)
  const edges: StoryEdge[] = []
  for (const member of edgesRaw) {
    const edge = normalizeEdge(member, warnings)
    if (edge) edges.push(edge)
  }

  // 项目必填元数据（容器就位后、逐项规则前补齐）
  const meta = normalizeProjectMeta(projectRaw, env, warnings)
  const viewport = normalizeViewportShape(graphRaw.viewport, warnings)

  const doc: ProjectDocument = {
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
  return { doc, optionIdRemap }
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

/** 分镜引用位的 MIME 家族与 kind 用途匹配（§4.2 六十四轮）：character/
 * location 是垫图/底图用途限 image/*，audio 用途限 audio/*。 */
function shotRefMimeMatches(kind: string, mime: string): boolean {
  if (kind === 'audio') return mime.startsWith('audio/')
  return mime.startsWith('image/')
}

/** 分镜节点的引用位警告（§11.4 + §4.2 六十四轮）：assetId 只按本项目
 * assets.byId 解析——目标缺失保留为悬空引用并警告（不删除用户选择）；
 * 目标存在但 MIME 家族与 kind 用途不匹配时保留为不可用引用并警告，
 * 不改按其他命名空间解释。 */
function shotRefWarnings(n: StoryNode, doc: ProjectDocument, warnings: string[]): void {
  const refs = (n.data.spec as { refs?: Array<{ id: string; kind: string; assetId?: string }> }).refs ?? []
  for (const ref of refs) {
    if (!ref.assetId) continue
    const asset = doc.assets?.byId[ref.assetId]
    if (!asset) {
      warnings.push(`节点 ${n.id} 的分镜引用指向不存在的资产 ${ref.assetId}`)
      continue
    }
    if (!shotRefMimeMatches(ref.kind, asset.mime)) {
      warnings.push(`节点 ${n.id} 的分镜引用 ${ref.id} 的 MIME 家族与 kind 用途不匹配（资产 ${ref.assetId} 为 ${asset.mime}），保留为不可用引用`)
    }
  }
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
 * 或 source 为 branch（§5 端口归属反向约束——branch 无匿名输出端口）
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
  // §5 端口归属反向约束：branch 无匿名输出端口，不能引出 sequence 边
  if (e.data.kind === 'sequence' && src.type === 'branch') return true
  if (e.data.kind !== 'branch') return false
  if (src.type !== 'branch') return true
  const optionId = branchOptionIdOf(e.sourceHandle)
  const options = (src.data.spec as BranchSpec).options
  return optionId === undefined || !options.some((o) => o.id === optionId)
}

/** branch 边类型谓词：嵌套 data.kind 不能直接窄化联合，显式谓词供句柄改写使用。 */
function isBranchEdge(e: StoryEdge): e is BranchEdge {
  return e.data.kind === 'branch'
}

/** 空节点 id 重发后的边端点改写（§11.1 第 3 步）：空字符串可被脏写的
 * source/target 指向，唯一空 id 节点的映射明确、端点同步改写为新 id、
 * 连线保留；无映射（多个空 id 节点歧义，或端点值非空 id 串）时保持原值，
 * 随孤儿边规则隔离。 */
function rewriteBlankNodeEndpoints(
  e: StoryEdge,
  nodeIdRemap: Map<string, string>,
  warnings: string[],
): StoryEdge {
  const source = nodeIdRemap.get(e.source)
  const target = nodeIdRemap.get(e.target)
  if (source === undefined && target === undefined) return e
  const out = { ...e }
  if (source !== undefined) {
    out.source = source
    warnings.push(`边 ${e.id} 的 source 指向已重发的空节点 id，已改写为 ${source}`)
  }
  if (target !== undefined) {
    out.target = target
    warnings.push(`边 ${e.id} 的 target 指向已重发的空节点 id，已改写为 ${target}`)
  }
  return out
}

/** 空选项 id 重发后的引出边句柄改写（§11.1 第 3 步）：branch 的空选项 id
 * 在键控列表修复中重发且映射唯一（同一空白原值仅出现一次）时，option- 句柄
 * 指向原空 id 的边同步改写为新 id，避免改接丢失；无明确映射（歧义多次出现）
 * 的句柄不改写，随选项 id 重发失效后按孤儿边隔离。 */
function rewriteRemappedOptionHandles(
  e: StoryEdge,
  optionIdRemap: Map<string, Map<string, string>>,
  warnings: string[],
): StoryEdge {
  // option- 句柄只在 branch 边上有意义；attach/sequence 的异型句柄由
  // stripAlienHandles / 孤儿边规则处理，不在此改写
  if (!isBranchEdge(e)) return e
  const handle = e.sourceHandle
  if (typeof handle !== 'string' || !handle.startsWith('option-')) return e
  const mapped = optionIdRemap.get(e.source)?.get(handle.slice('option-'.length))
  if (mapped === undefined) return e
  warnings.push(`边 ${e.id} 的句柄 ${handle} 指向已重发的空选项 id，已改写为 option-${mapped}`)
  return { ...e, sourceHandle: `option-${mapped}` }
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
  // branch/attach 的 sourceHandle 承载连接语义（选项出口 / shots 端口），
  // JSON 边界擦除类型后的非字符串值无法剥离修复（剥离即改接语义），隔离该边
  const sh = (out as { sourceHandle?: unknown }).sourceHandle
  if ((kind === 'branch' || kind === 'attach') && sh !== undefined && typeof sh !== 'string') {
    warnings.push(`已隔离边 ${e.id}：${kind} 边的 sourceHandle 非字符串，无法绑定端口`)
    return null
  }
  return out
}

/** 节点 id 的非法原因（§8.1 共同值域：非空字符串）。 */
function nodeIdIssue(id: unknown): string {
  if (typeof id !== 'string') return '缺失或非字符串'
  if (!id.trim()) return '缺失或空白'
  return '重复'
}

/** 非法/重复节点 id 修复（§11.1 第 3 步）：id 缺失、非字符串或空白一律重发
 * 本域未占用的新 id——非法身份交付画布会令 React Flow 渲染/选中/删除歧义；
 * 合法 id 重复保留文档序首个、后续重发（按 id 的引用本就解析到首见项，重发
 * 节点成无连线孤儿由用户处置，不产生改接）。空 id 重发时建立「空 id → 新 id」
 * 映射供边端点改写——空字符串可被脏写的 source/target 指向，同一空 id 串仅
 * 一个节点持有时映射唯一、连线保留；多个节点同空 id 映射歧义则不建映射，
 * 指向空串的边随孤儿边规则隔离。 */
function reissueDuplicateNodeIds(
  nodes: StoryNode[],
  warnings: string[],
): { nodes: StoryNode[]; nodeIdRemap: Map<string, string> } {
  const blankCounts = new Map<string, number>()
  for (const n of nodes) {
    if (typeof n.id === 'string' && !n.id.trim()) {
      blankCounts.set(n.id, (blankCounts.get(n.id) ?? 0) + 1)
    }
  }
  const seen = new Set<string>()
  const nodeIdRemap = new Map<string, string>()
  const out = nodes.map((n) => {
    if (typeof n.id === 'string' && n.id.trim() && !seen.has(n.id)) {
      seen.add(n.id)
      return n
    }
    let fresh = uid('node')
    while (seen.has(fresh)) fresh = uid('node')
    seen.add(fresh)
    if (typeof n.id === 'string' && !n.id.trim() && blankCounts.get(n.id) === 1) {
      nodeIdRemap.set(n.id, fresh)
    }
    const shown = typeof n.id === 'string' && n.id.trim() ? `${n.id} ` : ''
    warnings.push(
      `节点 id ${shown}${nodeIdIssue(n.id)}：已重发新 id ${fresh}（合法 id 重复保留文档序首个，引用仍解析到首见节点）`,
    )
    return { ...n, id: fresh }
  })
  return { nodes: out, nodeIdRemap }
}

/** 重复/非法边 id 修复（§11.1 第 3 步，与节点 id 同款规则）：保留文档序
 * 首条，后续同 id 边重发本域未占用的新 id 并警告；缺失/非字符串/空 id
 * 同款重发。边 id 不被任何数据引用（端点/句柄只指向节点与选项），重发
 * 无副作用；身份唯一后 React Flow 的选中/删除不再歧义。 */
function reissueDuplicateEdgeIds(edges: StoryEdge[], warnings: string[]): StoryEdge[] {
  const seen = new Set<string>()
  return edges.map((e) => {
    if (typeof e.id === 'string' && e.id && !seen.has(e.id)) {
      seen.add(e.id)
      return e
    }
    let fresh = uid('edge')
    while (seen.has(fresh)) fresh = uid('edge')
    seen.add(fresh)
    const reason = typeof e.id === 'string' && e.id ? `边 id ${e.id} 重复` : '边 id 缺失或非法'
    warnings.push(`${reason}：保留文档序首条原 id，后续边已重发新 id ${fresh}`)
    return { ...e, id: fresh }
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

/** 逻辑重复边隔离（§11.3）：同 source/target/sourceHandle 的边保留文档序首条，
 * 其余按孤儿边隔离并警告——并行重复边会被 React Flow 重叠渲染，
 * 图遍历与统计也把同一关系重复计数。 */
function isolateDuplicateEdges(edges: StoryEdge[], warnings: string[]): StoryEdge[] {
  const seen = new Set<string>()
  return edges.filter((e) => {
    const key = `${e.source}\u0000${e.target}\u0000${e.sourceHandle ?? ''}`
    if (seen.has(key)) {
      warnings.push(`已隔离重复边 ${e.id}：与既有边同 source/target/sourceHandle（逻辑重复）`)
      return false
    }
    seen.add(key)
    return true
  })
}

/** 归一化（§11.1 第 2 步容器校验 → 第 3 步非法/重复节点与边 id 重发 →
 * 空端点/空选项句柄改写 → 句柄剥离 → §11.3 孤儿边隔离 → 第 3 步成环/
 * attach 宿主唯一/逻辑重复边隔离 → §11.2 选中态重置 → §11.4 悬空引用标记）。 */
function normalizeDocument(
  raw: Record<string, unknown>,
  env: NormalizeEnv,
): { doc: ProjectDocument; warnings: string[] } {
  const warnings: string[] = []
  const { doc: shaped, optionIdRemap } = normalizeContainers(raw, env, warnings)
  const { nodes: activeNodes, nodeIdRemap } = reissueDuplicateNodeIds(shaped.graph.nodes, warnings)
  // 空节点 id 重发后，branch 空选项句柄映射表的键同步迁移到新节点 id
  for (const [oldId, newId] of nodeIdRemap) {
    const handles = optionIdRemap.get(oldId)
    if (handles) {
      optionIdRemap.delete(oldId)
      optionIdRemap.set(newId, handles)
    }
  }
  const nodesById = new Map(activeNodes.map((n) => [n.id, n]))
  const edges = isolateDuplicateEdges(
    isolateExtraAttachHosts(
      isolateCycleEdges(
        reissueDuplicateEdgeIds(shaped.graph.edges, warnings)
          .map((e) => rewriteBlankNodeEndpoints(e, nodeIdRemap, warnings))
          .map((e) => rewriteRemappedOptionHandles(e, optionIdRemap, warnings))
          .map((e) => stripAlienHandles(e, warnings))
          .filter((e): e is StoryEdge => e !== null)
          .filter((e) => {
            const orphan = isOrphanEdge(e, nodesById)
            if (orphan) warnings.push(`已隔离孤儿边 ${e.id}：端点节点缺失、绑定选项不存在或端口归属不合法`)
            return !orphan
          }),
        warnings,
      ),
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

/** v0 键控列表的单字段预归一化：非数组重置为空并警告、异型成员按 keep
 * 谓词丢弃并警告（branch.options 有槽位保序要求，另行走位处理，不经此
 * 函数）。缺省是否物化空数组因字段而异：lines/refs 缺省会让迁移器 map
 * 崩溃，须补空；scene.characters 的缺省有语义（该场无头像列，
 * characterIds 路径不被覆盖），保持缺省。 */
function v0List(
  data: Record<string, unknown>,
  field: string,
  nid: string,
  keep: (m: unknown) => boolean,
  materialize: boolean,
  warnings: string[],
): void {
  const list = data[field]
  if (list === undefined) {
    if (materialize) data[field] = []
    return
  }
  if (!Array.isArray(list)) {
    warnings.push(`节点 ${nid} 的 ${field} 非数组，已重置为空数组`)
    data[field] = []
    return
  }
  const kept = list.filter(keep)
  if (kept.length !== list.length) {
    warnings.push(`节点 ${nid} 的 ${field} 含异型成员，已丢弃`)
    data[field] = kept
  }
}

/** v0 节点嵌套形状预归一化（迁移器解引用前置）：data 非对象重置为空对象；
 * 类型专属键控列表按 §4.2 各自的成员域过滤——branch.options 的字符串成员
 * 是合法旧形态须放行。损坏的单节点数据按可修复项处理，绝不让迁移器的
 * map/成员读取把整份旧档打成打不开。就地改写传入的成员对象。 */
function normalizeV0NodeShapes(nodes: Record<string, unknown>[], warnings: string[]): void {
  const isObjectMember = (m: unknown) => isPlainObject(m)
  for (const node of nodes) {
    const nid = typeof node.id === 'string' && node.id ? node.id : '(无 id)'
    let data: Record<string, unknown>
    if (isPlainObject(node.data)) {
      data = node.data
    } else {
      warnings.push(`节点 ${nid} 的 data 缺失或非对象，已重置为空对象`)
      data = {}
      node.data = data
    }
      switch (node.type) {
        case 'scene':
          v0List(data, 'characters', nid, isObjectMember, false, warnings)
          break
        case 'dialogue':
          v0List(data, 'lines', nid, isObjectMember, true, warnings)
          break
        case 'branch': {
          // 槽位保序（§11.1 ①）：旧下标句柄改写前不得压缩数组——异型成员以
          // 占位对象顶位（迁移器为其补发 id，改写后由 v1 形状校验移除并
          // 警告），指向该槽位的连线按孤儿边隔离而非滑向后一选项
          const options = data.options
          if (options === undefined) {
            data.options = []
            break
          }
          if (!Array.isArray(options)) {
            warnings.push(`节点 ${nid} 的 options 非数组，已重置为空数组`)
            data.options = []
            break
          }
          data.options = options.map((m, i) => {
            if (typeof m === 'string' || isPlainObject(m)) return m
            warnings.push(`节点 ${nid} 的 options 成员 #${i} 异型，已置占位`)
            return {}
          })
          break
        }
        case 'shot':
          v0List(data, 'refs', nid, isObjectMember, true, warnings)
          break
        default:
          break
      }
  }
}

/** v0 信封解析（parseProject 按 schemaVersion 分派）：图形容器/成员与节点
 * 嵌套形状先归一化再进迁移器（§11.1——损坏旧档按可修复数据对待），迁移
 * 链 ⑤ 把 v0 的 updated_at 瞬间带入 v1 信封（createdAt 缺省与之同刻，
 * 不用迁移时刻冒充），产物再以 v1 走完整归一化管线。 */
function parseLegacyProject(raw: Record<string, unknown>, env: NormalizeEnv): ParseResult {
  const env0 = raw as Partial<ProjectDocument> & {
    project?: Partial<ProjectDocument['project']>
    graph?: { nodes?: CanvasNode[]; edges?: Edge[]; viewport?: Viewport }
    settings?: unknown
    episodeTitles?: unknown
  }
  const v0Warnings: string[] = []
  const graphRaw = isPlainObject(env0.graph) ? (env0.graph as Record<string, unknown>) : {}
  if (!isPlainObject(env0.graph) && env0.graph !== undefined) {
    v0Warnings.push('graph 容器异型，已重置为空画布')
  }
  const v0Array = (v: unknown, label: string): unknown[] => {
    if (Array.isArray(v)) return v
    if (v !== undefined) v0Warnings.push(`${label} 非数组，已重置为空数组`)
    return []
  }
  const v0Members = (v: unknown[], label: string): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = []
    v.forEach((item, i) => {
      if (isPlainObject(item)) out.push(item)
      else v0Warnings.push(`${label} 的成员 #${i} 不是对象，已丢弃`)
    })
    return out
  }
  const v0Nodes = v0Members(v0Array(graphRaw.nodes, 'graph.nodes'), 'graph.nodes')
  normalizeV0NodeShapes(v0Nodes, v0Warnings)
  const legacy: ProjectContent = {
    name: env0.project?.name ?? '',
    createdAt: env0.project?.createdAt || undefined,
    nodes: v0Nodes as unknown as CanvasNode[],
    edges: v0Members(v0Array(graphRaw.edges, 'graph.edges'), 'graph.edges') as Edge[],
    settings: (env0.settings ?? {}) as ProjectContent['settings'],
    episodeTitles: normalizeEpisodeTitles(env0.episodeTitles, v0Warnings),
    viewport: graphRaw.viewport as Viewport | undefined,
  }
  const migrated = migrateProjectDocument(legacy)
  const legacyAtMs = Date.parse(
    typeof env0.project?.updatedAt === 'string' ? env0.project.updatedAt : '',
  )
  const legacyNow = Number.isFinite(legacyAtMs) ? new Date(legacyAtMs) : new Date()
  const doc = serializeProject(
    rewriteIndexOptionHandles(migrated.doc, v0Warnings),
    env0.project?.id ?? '',
    legacyNow,
  )
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
    return parseLegacyProject(raw as Record<string, unknown>, env)
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
