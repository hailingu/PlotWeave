/**
 * 会话文档 ⇄ ProjectDocument 互转与归一化管线入口（docs/data-model.md v1
 * §3/§11）。本文件是管线的公共门面与编排层：schemaVersion 信封判型、
 * v1 归一化的阶段编排（normalizeDocument）；容器/身份/节点/边/资产/悬空
 * 引用各阶段实现在 normalize*.ts，序列化方向在 serialize.ts，共享 JSON
 * 形状谓词在 jsonGuards.ts。归一化保证文档以当前形态进入会话——修复而非
 * 拒绝，单条坏数据（孤儿边、悬空引用）只记警告，不阻断加载。旧扁平 v0
 * 格式支持已退役（#519 处置）：schemaVersion 0 按版本过旧拒绝。同版本文档
 * 的字段演进（issue #100）：graph/settings/assets 容器级未知键按扩展字段
 * 无损保留（§11），不参与修复判定；顶层与 project 层是类型化封闭契约，
 * 演进须升级 schemaVersion。
 */
import { sameCanonicalJson } from './jsonGuards'
import { fromDocument } from './serialize'
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
import type { ProjectContent } from './content'
import {
  CURRENT_SCHEMA_VERSION,
  type ProjectDocument,
  type StoryEdge,
} from './document'

export { serializeProject } from './serialize'
export { shotRefMimeMatches } from './normalizeRefs'
export type { NormalizeEnv } from './normalizeContainers'

/** parseProject 的结果：交付会话的归一化内容 + 修复是否改写磁盘形态的
 * 标志（调用方据此回写落定，下次打开不再重复修复）+ 归一化警告（孤儿边
 * 隔离、悬空引用标记等，§11.3/§11.4）。 */
export interface ParseResult {
  content: ProjectContent
  /** 归一化修复改写了内容（重发 id/隔离边/规范化字段等）：
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

/** 形状判型警告（issue #338 评审，§11 第 0 步「均记录警告」）：Rust 对
 * 版本主张缺失/异型的 v1 信封按唯一形状判型交付并打 versionless 标记，
 * 判型修复必须可向用户解释——保存时标记随类型化重建消失、显式版本号补盖。 */
const SHAPE_CLASSIFIED_WARNING =
  '文件缺少有效的 schemaVersion（缺失或为无法表达版本的异型值），已按信封形状判型，保存时将补盖显式版本号'

/**
 * 归一化管线入口（§11）：schemaVersion 校验 → 归一化 → 会话文档。
 * 旧扁平 v0 格式（schemaVersion 0）已随格式支持退役（#519 处置）：按
 * 版本过旧拒绝，不进入迁移。env 携带加载路径的受信事实（projectId /
 * 索引名），供元数据修复使用。Rust 形状判型标记（versionless）在入口
 * 消费为判型警告（issue #338 评审）。
 *
 * 输入所有权契约（issue #102）：归一化**就地改写**传入的 raw 及其嵌套
 * 成员（v1 键控桶内嵌 id 以记录键改写、字段剥离/补默认）。调用后不得
 * 假设输入保持原样，也不得把调用后的 raw 再当原始档使用；需保留原始
 * 文档或嵌套引用的调用方须先自行克隆（structuredClone）再传入。入口
 * 内部的未改动快照仅服务 repaired 判定，不构成对调用方对象的保护。
 * raw 按 IPC 反序列化的单次消费产物设计，unknown 不承诺比上述契约更深
 * 的所有权约束。
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
  if (version === 0) {
    throw new Error(
      '项目文件版本过旧（schemaVersion 0 旧扁平格式）：该格式已不再受支持',
    )
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`文档版本过新（schemaVersion ${version}），请升级应用`)
  }

  // Rust 形状判型标记（versionless，§10.5/§11 第 0 步）：版本主张缺失或
  // 异型时按唯一 v1 信封形状判型交付并打标记，判型修复记录警告（issue
  // #338 评审）。该键经 Rust 类型化信封跨 IPC 携带，磁盘文件中的同名顶层
  // 键在反序列化时即被剥离，不会从文件内容误触发。
  const shapeClassified =
    (raw as { versionless?: unknown }).versionless === true

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
    repaired: !sameCanonicalJson(pristine, normalized),
    warnings: shapeClassified
      ? [SHAPE_CLASSIFIED_WARNING, ...warnings]
      : warnings,
    reissuedAssetAliases,
  }
}
