/**
 * §11.1 第 2 步容器级形状校验与文档装配（先于一切逐项规则；父容器先于
 * 子容器）：异型父/子容器重置为可遍历空容器，项目必填元数据补齐（受信 id
 * 覆盖、名称回退链、时间戳修复），并按顺序契约调度各阶段模块产出最终
 * ProjectDocument 与边端点/句柄改写所需的映射。
 */
import { isPlainObject, plainObjectEntries } from './jsonGuards'
import {
  CURRENT_SCHEMA_VERSION,
  type ProjectDocument,
  type StoryEdge,
  type StoryNode,
  type Viewport,
} from './document'
import { normalizeEpisodeTitles } from './legacy'
import {
  type BlankKeyRemaps,
  normalizeEntityShapes,
  normalizeSettingsBuckets,
  reKeyBlankEntries,
  reKeyUnsafeCharacterKeys,
  rewriteBlankKeyReferences,
  rewriteCharacterMentionTokens,
} from './normalizeSettings'
import {
  capturePreRepairIds,
  compatLegacyShotTargetIds,
  type IdentitySnapshot,
  identitySnapshot,
  isStrictIso8601,
  normalizeAssetRecords,
} from './normalizeAssets'
import { normalizeEdge, normalizeNode, renumberSeqFields } from './normalizeNodes'
import { reissueDuplicateNodeIds } from './normalizeEdges'

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

/** 项目必填元数据修复：受信 id 覆盖、名称回退链、时间戳修复、非字符串描述剥离.
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
      // 规范化结果须仍在可保存域（四位年份）：合法的极端偏移换算成 UTC
      // 可越过 9999 年（toISOString 产出 +010000-…），前端谓词与 Rust
      // 保存边界都不再接受——修复回写与后续自动保存全被拒收，项目永久
      // 不可保存；越域即按不可修复走回退链
      if (isStrictIso8601(canon)) {
        if (canon !== v) {
          warnings.push(`project.${label} 是合法的偏移/精度变体，已确定性规范化为 UTC ISO 8601`)
        }
        return canon
      }
      warnings.push(`project.${label} 规范化后越出四位年份域，${fallbackReason}`)
      return fallback
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

/** 键控桶身份修复产物（§11.1 第 3 步）：空键/不安全键重发映射与修复
 * 前后身份快照——targetId 兼容判定与同桶引用改写的共同输入。 */
interface BucketIdentityRepairs {
  blankRemaps: BlankKeyRemaps
  characterIds0: IdentitySnapshot[]
  locationIds0: IdentitySnapshot[]
  assetIds0: IdentitySnapshot[]
}

/** 键控桶的空记录键/角色安全子值域重发与身份快照（§11.1 第 3 步记录键
 * 非空前置，先于形状校验与键 id 一致性改写；角色桶另执行安全子值域重发
 * （§6 五十九轮，映射并入同一改写通道）；引用改写待节点就位后统一执行）。 */
function reKeyBucketIdentities(
  settings: Record<string, Record<string, unknown>>,
  byId: Record<string, Record<string, unknown>>,
  warnings: string[],
): BucketIdentityRepairs {
  // 桶成员已经 plainObjectEntries 过滤为普通对象
  const entityBucket = (bucket: string) =>
    settings[bucket] as Record<string, Record<string, unknown>>
  // 六十四轮 targetId 兼容的「修复前身份」捕获：须在一切键/id 改写（空键
  // 重发、角色安全子值域重发、键 id 一致性改写）之前以条目对象引用完成
  const preCharacterIds = capturePreRepairIds(entityBucket('characters'))
  const preLocationIds = capturePreRepairIds(entityBucket('locations'))
  const preAssetIds = capturePreRepairIds(byId)
  const characterRemaps = reKeyBlankEntries(
    entityBucket('characters'),
    'settings.characters',
    'ch',
    warnings,
  )
  for (const [oldKey, newKey] of reKeyUnsafeCharacterKeys(entityBucket('characters'), warnings)) {
    characterRemaps.set(oldKey, newKey)
  }
  const blankRemaps: BlankKeyRemaps = {
    characters: characterRemaps,
    locations: reKeyBlankEntries(entityBucket('locations'), 'settings.locations', 'loc', warnings),
    assets: reKeyBlankEntries(
      byId,
      'assets.byId',
      'asset',
      warnings,
    ),
  }
  // props/documents 桶无节点引用面，仅重发空键保证身份可用
  reKeyBlankEntries(entityBucket('props'), 'settings.props', 'prop', warnings)
  reKeyBlankEntries(entityBucket('documents'), 'settings.documents', 'doc', warnings)
  // 六十四轮 targetId 兼容的身份快照：最终记录键 + 修复前身份（改写前捕获）
  return {
    blankRemaps,
    characterIds0: identitySnapshot(entityBucket('characters'), preCharacterIds),
    locationIds0: identitySnapshot(entityBucket('locations'), preLocationIds),
    assetIds0: identitySnapshot(byId, preAssetIds),
  }
}

/** 桶条目的形状校验与旧草案兼容（§11.1 第 3 步）：设定实体必填字段隔离、
 * 资产 AssetRef 完整校验、分镜 refs 的 targetId 兼容转换/隔离——均就地
 * 改写传入的桶与节点原始成员。 */
function sanitizeBucketEntries(
  settings: Record<string, Record<string, unknown>>,
  byId: Record<string, Record<string, unknown>>,
  nodesRaw: unknown[],
  env: NormalizeEnv,
  repairs: BucketIdentityRepairs,
  warnings: string[],
): void {
  normalizeEntityShapes(settings, warnings)
  // plainObjectEntries 已过滤为普通对象成员；实路径不可验证键经空键重发
  // 映射对齐（重发换键不改变媒体文件的事实）
  const invalidAssets = new Set(
    (env.invalidAssetKeys ?? []).map((k) => repairs.blankRemaps.assets.get(k) ?? k),
  )
  normalizeAssetRecords(byId, warnings, invalidAssets)
  // 旧草案 targetId 兼容：先于节点联合校验（refs 成员形状筛选只认当前联合）
  compatLegacyShotTargetIds(
    nodesRaw,
    {
      characters: settings.characters as Record<string, Record<string, unknown>>,
      characterIds0: repairs.characterIds0,
      locations: settings.locations as Record<string, Record<string, unknown>>,
      locationIds0: repairs.locationIds0,
      byId,
      assetIds0: repairs.assetIds0,
      assetRemap: repairs.blankRemaps.assets,
    },
    warnings,
  )
}

/** 活动节点集修复（§11.1 第 3 步顺序契约：id 修复先于形状隔离，
 * reissueDuplicateNodeIds 文档注释）：节点 id 重发 → 嵌套容器/判别联合
 * 校验 → 编号顺位重发 → 空键重发引用改写与提及 token 同步。边端点与
 * 句柄改写用的映射随管线带出。 */
function normalizeActiveNodes(
  nodesRaw: unknown[],
  settings: Record<string, Record<string, unknown>>,
  blankRemaps: BlankKeyRemaps,
  warnings: string[],
): {
  nodes: StoryNode[]
  optionIdRemap: Map<string, Map<string, string>>
  nodeIdRemap: Map<string, string>
} {
  const { members: idRepaired, nodeIdRemap } = reissueDuplicateNodeIds(nodesRaw, warnings)
  const optionIdRemap = new Map<string, Map<string, string>>()
  const nodes: StoryNode[] = []
  for (const member of idRepaired) {
    const node = normalizeNode(member, warnings, optionIdRemap)
    if (node) nodes.push(node)
  }
  renumberSeqFields(nodes, warnings)
  rewriteBlankKeyReferences(nodes, settings, blankRemaps, warnings)
  rewriteCharacterMentionTokens(nodes, blankRemaps.characters, warnings)
  return { nodes, optionIdRemap, nodeIdRemap }
}

/** 修复产物装配为 ProjectDocument（episodeTitles 已在调用侧完成键值域
 * 修复——§11.1 第 3 步对所有版本执行，修复是否改写内容以装配产物为准：
 * 只留在 fromDocument 会让回写判定（repaired）看不见标题去空白/非法键
 * 删除；fromDocument 的二次归一化幂等）。 */
function assembleDocument(
  meta: ReturnType<typeof normalizeProjectMeta>,
  nodes: StoryNode[],
  edges: StoryEdge[],
  viewport: Viewport | undefined,
  settings: Record<string, Record<string, unknown>>,
  byId: Record<string, unknown>,
  episodeTitles: ProjectDocument['episodeTitles'],
): ProjectDocument {
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
    episodeTitles,
    assets: { byId: byId as unknown as Record<string, ProjectDocument['assets']['byId'][string]> },
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
export function normalizeContainers(
  raw: Record<string, unknown>,
  env: NormalizeEnv,
  warnings: string[],
): {
  doc: ProjectDocument
  optionIdRemap: Map<string, Map<string, string>>
  nodeIdRemap: Map<string, string>
} {
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

  // 成员过滤 + 嵌套容器修复；键控桶身份重发、形状校验与旧草案兼容按
  // 阶段模块执行，活动节点集随后修复
  const settings = normalizeSettingsBuckets(settingsRaw, warnings)
  const assetIndex = plainObjectEntries(assetsRaw.byId, 'assets.byId', warnings) as Record<
    string,
    Record<string, unknown>
  >
  const repairs = reKeyBucketIdentities(settings, assetIndex, warnings)
  sanitizeBucketEntries(settings, assetIndex, nodesRaw, env, repairs, warnings)
  const titlesRaw = containerOf(raw.episodeTitles, 'episodeTitles 非普通键值对象，已重置为空 Record')
  const { nodes, optionIdRemap, nodeIdRemap } = normalizeActiveNodes(
    nodesRaw,
    settings,
    repairs.blankRemaps,
    warnings,
  )
  const edges: StoryEdge[] = []
  for (const member of edgesRaw) {
    const edge = normalizeEdge(member, warnings)
    if (edge) edges.push(edge)
  }

  // 项目必填元数据（容器就位后、逐项规则前补齐）
  const meta = normalizeProjectMeta(projectRaw, env, warnings)
  const viewport = normalizeViewportShape(graphRaw.viewport, warnings)
  const doc = assembleDocument(
    meta,
    nodes,
    edges,
    viewport,
    settings,
    assetIndex,
    normalizeEpisodeTitles(titlesRaw, warnings) as unknown as ProjectDocument['episodeTitles'],
  )
  return { doc, optionIdRemap, nodeIdRemap }
}
