/**
 * 会话文档 ⇄ ProjectDocument 互转与归一化管线入口（docs/data-model.md v1
 * §3/§11）。本文件是管线的公共门面与编排层：schemaVersion 信封判型、v0
 * 旧信封的预归一化与迁移调度、v1 归一化的阶段编排（normalizeDocument）；
 * 容器/身份/节点/边/资产/悬空引用各阶段实现在 normalize*.ts，序列化方向
 * 在 serialize.ts，共享 JSON 形状谓词在 jsonGuards.ts。归一化保证任何
 * 历史版本的文档都以当前形态进入会话——修复而非拒绝，单条坏数据（孤儿
 * 边、悬空引用）只记警告，不阻断加载。同版本文档的字段演进（issue #100）：
 * graph/settings/assets 容器级未知键按扩展字段无损保留（§11），不参与
 * 修复判定；顶层与 project 层是类型化封闭契约，演进须升级 schemaVersion。
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
import {
  characterAvatarWarnings,
  collectDanglingRefWarnings,
} from './normalizeRefs'
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
  /** 资产空白键重发映射（[空白键, 新 id]，issue #31 评审修复 P2-3）：
   * 供 Tauri 侧经 register_project_asset_alias 登记别名——修复回写落盘前，
   * 重发 id 的媒体经盘上条目解析。 */
  reissuedAssetAliases: [string, string][]
}

/** 归一化（§11.1 第 2 步容器校验 → 第 3 步非法/重复节点与边 id 重发 →
 * 空端点/空选项句柄改写 → 句柄剥离 → §11.3 孤儿边隔离 → 第 3 步成环/
 * attach 宿主唯一/逻辑重复边隔离 → §11.2 选中态重置 → §11.4 悬空引用标记）。 */
function normalizeDocument(
  raw: Record<string, unknown>,
  env: NormalizeEnv,
): {
  doc: ProjectDocument
  warnings: string[]
  reissuedAssetAliases: [string, string][]
} {
  const warnings: string[] = []
  const {
    doc: shaped,
    optionIdRemap,
    nodeIdRemap,
    reissuedAssetAliases,
  } = normalizeContainers(raw, env, warnings)
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
            if (orphan)
              warnings.push(
                `已隔离孤儿边 ${e.id}：端点节点缺失、绑定选项不存在或端口归属不合法`,
              )
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
  return {
    doc: { ...shaped, graph: { ...shaped.graph, nodes, edges } },
    warnings,
    reissuedAssetAliases,
  }
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
      // 台词 speaker 域预检（§11 v0 兼容子步骤：异型 speaker 删除并警告，
      // issue #335）：字符串 id 引用与 null/缺失不在此处置，交由空键重发/
      // 悬空引用规则；对象头像走 isUsableAvatar——label 空白/缺失会让迁移
      // 的 ensureCharacter 以 startsWith('') 命中首个既有角色（静默错关联）
      // ——不可用头像置空；其余异型（数组等 truthy object 会让迁移的
      // ensureCharacter 对 label 调 trim 时崩溃，数值/布尔会被 v1 的
      // speaker 域剥离）同样置空，单字段损坏不得放大为整档不可解析
      for (const line of data.lines as Record<string, unknown>[]) {
        if (
          line.speaker !== null &&
          line.speaker !== undefined &&
          typeof line.speaker !== 'string' &&
          !isPlainObject(line.speaker)
        ) {
          warnings.push(
            `节点 ${nid} 的对白行 speaker 异型（须字符串 id、对象头像或 null），已置空`,
          )
          line.speaker = null
        } else if (
          isPlainObject(line.speaker) &&
          !isUsableAvatar(line.speaker)
        ) {
          warnings.push(
            `节点 ${nid} 的对白行 speaker 头像不可用（label 缺失/空白或 gradient 异型），已置空`,
          )
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
function normalizeV0Options(
  data: Record<string, unknown>,
  nid: string,
  warnings: string[],
): void {
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
/** v0 信封 → 迁移器入口内容（parseLegacyProject 拆分，issue #99）：
 * 容器/成员修复只到「可遍历形态」（§11.1 损坏旧档按可修复数据对待），
 * 节点形态预归一化；宽化只存在于迁移入站，产物以 v1 重走完整管线。 */
function assembleLegacyContent(
  env0: Partial<ProjectDocument> & {
    project?: Partial<ProjectDocument['project']>
    graph?: { nodes?: CanvasNode[]; edges?: Edge[]; viewport?: Viewport }
    settings?: unknown
    episodeTitles?: unknown
  },
  warnings: string[],
): ProjectContent {
  const graphRaw = isPlainObject(env0.graph)
    ? (env0.graph as Record<string, unknown>)
    : {}
  if (!isPlainObject(env0.graph) && env0.graph !== undefined) {
    warnings.push('graph 容器异型，已重置为空画布')
  }
  const asArray = (v: unknown, label: string): unknown[] => {
    if (Array.isArray(v)) return v
    if (v !== undefined) warnings.push(`${label} 非数组，已重置为空数组`)
    return []
  }
  const members = (v: unknown[], label: string): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = []
    v.forEach((item, i) => {
      if (isPlainObject(item)) out.push(item)
      else warnings.push(`${label} 的成员 #${i} 不是对象，已丢弃`)
    })
    return out
  }
  // v0 安全预检（§11 第 0 步，issue #336）：settings 容器异型或设定数组桶
  // 缺失/非数组时重置并记录「无法机械恢复内容」警告——重置不得静默清洗，
  // 否则修复回写把内容丢失固化为无诊断的空设定集（下游 repaired=true 却
  // 无从知晓丢了什么）。合法数组与其余键原样交给迁移器 normalizeSettings；
  // settings 键缺失时无内容可失，按既有行为静默补空对象、不告警。
  const settingsRaw: unknown = env0.settings
  let settings: ProjectContent['settings']
  if (settingsRaw === undefined) {
    settings = {} as ProjectContent['settings']
  } else if (!isPlainObject(settingsRaw)) {
    warnings.push('settings 非普通对象，无法机械恢复内容，已重置为空对象')
    settings = {} as ProjectContent['settings']
  } else {
    const record = settingsRaw as Record<string, unknown>
    for (const bucket of ['characters', 'locations'] as const) {
      if (!Array.isArray(record[bucket])) {
        warnings.push(
          record[bucket] === undefined
            ? `settings.${bucket} 缺失，无法机械恢复内容，已重置为空数组`
            : `settings.${bucket} 非数组，无法机械恢复内容，已重置为空数组`,
        )
        record[bucket] = []
      }
    }
    settings = record as unknown as ProjectContent['settings']
  }
  return {
    name: env0.project?.name ?? '',
    createdAt: env0.project?.createdAt || undefined,
    nodes: normalizeV0NodeShapes(
      members(asArray(graphRaw.nodes, 'graph.nodes'), 'graph.nodes'),
      warnings,
    ) as unknown as CanvasNode[],
    edges: members(
      asArray(graphRaw.edges, 'graph.edges'),
      'graph.edges',
    ) as Edge[],
    settings,
    episodeTitles: normalizeEpisodeTitles(env0.episodeTitles, warnings),
    viewport: graphRaw.viewport as Viewport | undefined,
  }
}

/** 形状判型警告（issue #338 评审，§11 第 0 步「均记录警告」）：Rust 对
 * 版本主张缺失/异型的信封按唯一形状判型交付并打 versionless 标记，判型
 * 修复必须可向用户解释——保存时标记随类型化重建消失、显式版本号补盖。 */
const SHAPE_CLASSIFIED_WARNING =
  '文件缺少有效的 schemaVersion（缺失或为无法表达版本的异型值），已按信封形状判型，保存时将补盖显式版本号'

function parseLegacyProject(
  raw: Record<string, unknown>,
  env: NormalizeEnv,
  shapeClassified: boolean,
): ParseResult {
  const env0 = raw as Parameters<typeof assembleLegacyContent>[0]
  const v0Warnings: string[] = []
  if (shapeClassified) v0Warnings.push(SHAPE_CLASSIFIED_WARNING)
  const legacy = assembleLegacyContent(env0, v0Warnings)
  const migrated = migrateProjectDocument(legacy, v0Warnings)
  const legacyAtMs = Date.parse(
    typeof env0.project?.updatedAt === 'string' ? env0.project.updatedAt : '',
  )
  const legacyNow = Number.isFinite(legacyAtMs)
    ? new Date(legacyAtMs)
    : new Date()
  const doc = serializeProject(
    rewriteIndexOptionHandles(migrated.doc, v0Warnings),
    env0.project?.id ?? '',
    legacyNow,
  )
  const {
    doc: normalized,
    warnings,
    reissuedAssetAliases,
  } = normalizeDocument(
    // 边界（issue 16）：刚构造的 ProjectDocument 以原始 JSON 形态进入归一化
    // 容器校验（§11.1 第 2 步从 Record 起步），方向是「收窄到可遍历形态」
    doc as unknown as Record<string, unknown>,
    env,
  )
  return {
    content: fromDocument(normalized, warnings),
    migrated: true,
    repaired: true,
    warnings: [...v0Warnings, ...warnings],
    reissuedAssetAliases,
  }
}

/**
 * 归一化管线入口（§11）：schemaVersion 校验与迁移 → 归一化 → 会话文档。
 * v0 信封（旧扁平格式经 Rust 包装）先走节点字段迁移，再按 v1 解析。
 * env 携带加载路径的受信事实（projectId / 索引名），供元数据修复使用。
 * Rust 形状判型标记（versionless）在入口消费为判型警告（issue #338 评审）。
 *
 * 输入所有权契约（issue #102）：归一化/迁移**就地改写**传入的 raw 及其
 * 嵌套成员（v1 键控桶内嵌 id 以记录键改写、字段剥离/补默认；v0 预归一化
 * 重置数组、补 position 等同样落在调用方对象上）。调用后不得假设输入保持
 * 原样，也不得把调用后的 raw 再当原始档使用；需保留原始文档或嵌套引用的
 * 调用方须先自行克隆（structuredClone）再传入。入口内部的未改动快照仅
 * 服务 repaired 判定，不构成对调用方对象的保护。raw 按 IPC 反序列化的
 * 单次消费产物设计，unknown 不承诺比上述契约更深的所有权约束。
 */
export function parseProject(
  raw: unknown,
  env: NormalizeEnv = {},
): ParseResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('项目文件损坏：不是有效的文档对象')
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 0
  ) {
    throw new TypeError(
      '项目文件损坏：schemaVersion 缺失或非法（须为非负安全整数，§11.1 第 0 步）',
    )
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`文档版本过新（schemaVersion ${version}），请升级应用`)
  }

  // Rust 形状判型标记（versionless，§10.5/§11 第 0 步）：版本主张缺失或
  // 异型时按唯一信封形状判型交付（v1/v0 两族都打标记），判型修复记录
  // 警告（issue #338 评审）。该键经 Rust 类型化信封跨 IPC 携带，磁盘文件
  // 中的同名顶层键在反序列化时即被剥离，不会从文件内容误触发。
  const shapeClassified =
    (raw as { versionless?: unknown }).versionless === true

  if (version === 0) {
    return parseLegacyProject(
      raw as Record<string, unknown>,
      env,
      shapeClassified,
    )
  }

  // 原始文档先克隆：归一化就地改写（id 重发/字段剥离/隔离，输入所有权
  // 契约见上方 parseProject 公开说明），事后与改写产物比较须以未改动的
  // 原始为基准——repaired 决定调用方是否回写落定修复
  const pristine = structuredClone(raw)
  const {
    doc: normalized,
    warnings,
    reissuedAssetAliases,
  } = normalizeDocument(raw as Record<string, unknown>, env)
  return {
    content: fromDocument(normalized, warnings),
    migrated: false,
    repaired: !sameCanonicalJson(pristine, normalized),
    warnings: shapeClassified
      ? [SHAPE_CLASSIFIED_WARNING, ...warnings]
      : warnings,
    reissuedAssetAliases,
  }
}
