/**
 * 会话文档 ⇄ ProjectDocument 互转与归一化管线入口（docs/data-model.md v1
 * §3/§11）。本文件是管线的公共门面与编排层：schemaVersion 信封判型、v0
 * 旧信封的预归一化与迁移调度、v1 归一化的阶段编排（normalizeDocument）；
 * 容器/身份/节点/边/资产/悬空引用各阶段实现在 normalize*.ts，序列化方向
 * 在 serialize.ts，共享 JSON 形状谓词在 jsonGuards.ts。归一化保证任何
 * 历史版本的文档都以当前形态进入会话——修复而非拒绝，单条坏数据（孤儿
 * 边、悬空引用）只记警告，不阻断加载。
 */
import type { Edge } from '@xyflow/react'
import type { CanvasNode } from '../editor/nodes/types'
import { isPlainObject, sameCanonicalJson } from './jsonGuards'
import { fromDocument, serializeProject } from './serialize'
import { normalizeContainers } from './normalizeContainers'
import type { NormalizeEnv } from './normalizeContainers'
import {
  isOrphanEdge,
  isolateCycleEdges,
  isolateDuplicateEdges,
  isolateExtraAttachHosts,
  reissueDuplicateEdgeIds,
  rewriteBlankNodeEndpoints,
  rewriteRemappedOptionHandles,
  stripAlienHandles,
} from './normalizeEdges'
import { characterAvatarWarnings, collectDanglingRefWarnings } from './normalizeRefs'
import {
  migrateProjectDocument,
  normalizeEpisodeTitles,
  rewriteIndexOptionHandles,
} from './legacy'
import type { ProjectContent } from './content'
import {
  CURRENT_SCHEMA_VERSION,
  type ProjectDocument,
  type StoryEdge,
  type Viewport,
} from './document'

export { serializeProject } from './serialize'
export { shotRefMimeMatches } from './normalizeRefs'
export type { NormalizeEnv } from './normalizeContainers'

/** parseProject 的结果：交付会话的归一化内容 + 迁移/修复是否改写磁盘
 * 形态的标志（调用方据此回写落定，下次打开不再重复修复）+ 归一化警告
 * （孤儿边隔离、悬空引用标记等，§11.3/§11.4）。 */
export interface ParseResult {
  content: ProjectContent
  /** 发生了格式迁移（v0 → v1），调用方应回写磁盘。 */
  migrated: boolean
  /** 归一化修复改写了内容（重发 id/隔离边/规范化字段等，含 v0 迁移）：
   * 同样应回写磁盘——只修在内存时，用户只开不编辑（防抖保存跳过首帧）
   * 会让脏文件长留磁盘，每次打开都重新生成不同的"稳定" id、重复修复。 */
  repaired: boolean
  /** 归一化警告：孤儿边隔离、悬空引用标记（§11.3/§11.4）。 */
  warnings: string[]
}

/** 归一化（§11.1 第 2 步容器校验 → 第 3 步非法/重复节点与边 id 重发 →
 * 空端点/空选项句柄改写 → 句柄剥离 → §11.3 孤儿边隔离 → 第 3 步成环/
 * attach 宿主唯一/逻辑重复边隔离 → §11.2 选中态重置 → §11.4 悬空引用标记）。 */
function normalizeDocument(
  raw: Record<string, unknown>,
  env: NormalizeEnv,
): { doc: ProjectDocument; warnings: string[] } {
  const warnings: string[] = []
  const { doc: shaped, optionIdRemap, nodeIdRemap } = normalizeContainers(raw, env, warnings)
  const activeNodes = shaped.graph.nodes
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
function normalizeV0NodeShapes(
  nodes: Record<string, unknown>[],
  warnings: string[],
): Record<string, unknown>[] {
  const isObjectMember = (m: unknown) => isPlainObject(m)
  /** 头像成员预过滤谓词（迁移链 ④ 前置，场景头像与对白 speaker 共用）：
   * 非空白字符串 label + 可选字符串 gradient 才可用——空 label 会让
   * ensureCharacter 以 startsWith('') 命中首个既有角色（静默错关联），
   * 缺失/异型 label 补建的实体也终将被隔离。 */
  const isUsableAvatar = (m: unknown) =>
    isPlainObject(m) &&
    typeof m.label === 'string' &&
    m.label.trim() !== '' &&
    (m.gradient === undefined || typeof m.gradient === 'string')
  return nodes.filter((node) => {
    // data 容器异型（null/字符串等）整个节点隔离（§11.1 第 0 步）：重置为
    // {} 会让迁移造出 lines:[] + 空 label 的"合法"空白节点——修复回写把
    // 损坏节点永久固化成空白节点；关联边随孤儿边规则隔离
    if (!isPlainObject(node.data)) {
      const nid = typeof node.id === 'string' && node.id ? node.id : '(无 id)'
      warnings.push(`节点 ${nid} 的 data 缺失或非对象，无法机械修复，已隔离`)
      return false
    }
    normalizeV0NodeShape(node, isObjectMember, isUsableAvatar, warnings)
    return true
  })
}

/** 单个 v0 节点的嵌套形状预归一化（normalizeV0NodeShapes 内核，仅处理
 * data 容器为普通对象的节点——异型容器已由调用方隔离）：position 缺失/
 * 非对象补默认 (0,0)（toStoryNode 解引用 n.position.x，不补则单个损坏
 * 旧节点令整档迁移崩溃）；类型专属列表见 v0List。 */
function normalizeV0NodeShape(
  node: Record<string, unknown>,
  isObjectMember: (m: unknown) => boolean,
  isUsableAvatar: (m: unknown) => boolean,
  warnings: string[],
): void {
  const nid = typeof node.id === 'string' && node.id ? node.id : '(无 id)'
  if (!isPlainObject(node.position)) {
    warnings.push(`节点 ${nid} 的 position 缺失或非对象，已置 (0,0)`)
    node.position = { x: 0, y: 0 }
  }
  const data = node.data as Record<string, unknown>
  switch (node.type) {
    case 'scene':
      v0List(data, 'characters', nid, isUsableAvatar, false, warnings)
      break
    case 'dialogue': {
      v0List(data, 'lines', nid, isObjectMember, true, warnings)
      // 台词 speaker 头像与场景头像同一谓词（isUsableAvatar）：对象形态
      // speaker 的 label 空白/缺失会让迁移的 ensureCharacter 以
      // startsWith('') 命中首个既有角色（静默错关联）——不可用头像置空；
      // 字符串 id 引用不在此处置，交由空键重发/悬空引用规则处理
      for (const line of data.lines as Record<string, unknown>[]) {
        if (isPlainObject(line.speaker) && !isUsableAvatar(line.speaker)) {
          warnings.push(`节点 ${nid} 的对白行 speaker 头像不可用（label 缺失/空白或 gradient 异型），已置空`)
          line.speaker = null
        }
      }
      break
    }
    case 'branch':
      normalizeV0Options(data, nid, warnings)
      break
    case 'shot':
      v0List(data, 'refs', nid, isObjectMember, true, warnings)
      break
    default:
      break
  }
}

/** branch.options 的槽位保序预归一化（§11.1 ①）：旧下标句柄改写前不得
 * 压缩数组——异型成员以占位对象顶位（迁移器为其补发 id，改写后由 v1
 * 形状校验移除并警告），指向该槽位的连线按孤儿边隔离而非滑向后一选项。 */
function normalizeV0Options(data: Record<string, unknown>, nid: string, warnings: string[]): void {
  const options = data.options
  if (options === undefined) {
    data.options = []
    return
  }
  if (!Array.isArray(options)) {
    warnings.push(`节点 ${nid} 的 options 非数组，已重置为空数组`)
    data.options = []
    return
  }
  data.options = options.map((m, i) => {
    if (typeof m === 'string' || isPlainObject(m)) return m
    warnings.push(`节点 ${nid} 的 options 成员 #${i} 异型，已置占位`)
    return {}
  })
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
  const v0Nodes = normalizeV0NodeShapes(
    v0Members(v0Array(graphRaw.nodes, 'graph.nodes'), 'graph.nodes'),
    v0Warnings,
  )
  const legacy: ProjectContent = {
    name: env0.project?.name ?? '',
    createdAt: env0.project?.createdAt || undefined,
    nodes: v0Nodes as unknown as CanvasNode[],
    edges: v0Members(v0Array(graphRaw.edges, 'graph.edges'), 'graph.edges') as Edge[],
    settings: (env0.settings ?? {}) as ProjectContent['settings'],
    episodeTitles: normalizeEpisodeTitles(env0.episodeTitles, v0Warnings),
    viewport: graphRaw.viewport as Viewport | undefined,
  }
  const migrated = migrateProjectDocument(legacy, v0Warnings)
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
    repaired: true,
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
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new TypeError('项目文件损坏：schemaVersion 缺失或非法（须为非负安全整数，§11.1 第 0 步）')
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`文档版本过新（schemaVersion ${version}），请升级应用`)
  }

  if (version === 0) {
    return parseLegacyProject(raw as Record<string, unknown>, env)
  }

  // 原始文档先克隆：归一化就地改写（id 重发/字段剥离/隔离），事后与改写
  // 产物比较须以未改动的原始为基准——repaired 决定调用方是否回写落定修复
  const pristine = structuredClone(raw)
  const { doc: normalized, warnings } = normalizeDocument(raw as Record<string, unknown>, env)
  return {
    content: fromDocument(normalized, warnings),
    migrated: false,
    repaired: !sameCanonicalJson(pristine, normalized),
    warnings,
  }
}
