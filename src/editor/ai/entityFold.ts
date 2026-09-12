import type {
  BatchIssue,
  PreviewItem,
  ValidatedCommand,
  ValidatedDocumentFields,
  ValidatedEntityFields,
} from './commands'
import {
  AI_DOCUMENT_FIELDS,
  AI_ENTITY_FIELDS,
  ENTITY_KIND_LABELS,
  type EntityKind,
  type EntityTokenScope,
} from './entityFields'
import { plainObject } from './patchShape'

/**
 * AI 设定实体命令（upsert_character / upsert_location）与设定文档命令
 * （upsert_document，issue 56）的折叠校验实现域（issue 44）：与 batchFold.ts
 * 的节点折叠同一语义——在「当前设定集 + 本批已建/已改」的虚拟投影上完成
 * fields 白名单/值形状校验、entityId 解析（既有 id 或本批 ref 别名）与 ref
 * 登记，产出预览条目与已校验命令。修改必须精确指向 id（名称只作展示，绝不
 * 作为定位或覆盖依据）；阶段 B 首错即停——失败 upsert 之后的命令不进入折叠，
 * ref 不会悬空指向未入图的虚拟实体。文档不需要 ref 别名（无节点字段引用
 * 文档），entityId 只解析 documents 桶。
 */

/** 折叠期新建实体的虚拟 id（不进设定集，仅同批 ref 解析用）。基形
 * __ent__:<index>，与两桶任一既有 id 重合时追加 '#' 直至避开：角色/地点
 * id 无保留前缀约束，持久化 id 可与基形同形——虚拟 id 抢占桶位会把既有实体
 * 误当本批新建（引用校验放行、执行期不解析，落盘悬空绑定）。 */
const virtualEntityIdOf = (st: EntityFoldHost, index: number): string => {
  let id = `__ent__:${index}`
  while (st.characters.has(id) || st.locations.has(id)) id += '#'
  return id
}

/** 折叠器共享的实体状态与收集器（batchFold.FoldState 经此接口消费）。 */
export interface EntityFoldHost {
  /** 既有 + 本批投影的实体 id → 名称（新建为虚拟 id，执行期才分配真实 id）。 */
  characters: Map<string, string>
  locations: Map<string, string>
  /** 既有文档 id → 标题（issue 56）：upsert_document 的 entityId 解析与
   * 预览标签消费；文档不建虚拟投影（无批内 ref 可指向文档）。 */
  documents: Map<string, string>
  /** 本批新建的虚拟投影 id：仅可经声明的 ref 别名解析，不得作为引用
   * token 直接命中桶位（执行层只解析别名表，直接放行会落盘悬空绑定）。
   * 显式集合而非前缀判断——持久化 id 可能与虚拟 id 同形。 */
  virtualEntityIds: Set<string>
  /** ref 别名 → 所属实体（kind + id；新建指向虚拟 id）。 */
  entityRefs: Map<string, { kind: EntityKind; id: string }>
  /** 快照未携带设定集时不做实体校验（旧夹具兼容）；运行时快照恒携带。 */
  entityScope?: EntityTokenScope
  items: PreviewItem[]
  issues: BatchIssue[]
  commands: ValidatedCommand[]
  fail: (index: number, message: string) => void
}

const bucketOf = (st: EntityFoldHost, kind: EntityKind): Map<string, string> =>
  kind === 'character' ? st.characters : st.locations

const otherKind = (kind: EntityKind): EntityKind => (kind === 'character' ? 'location' : 'character')

/** 实体 token 解析口径：快照给批次校验消费（patchShape 的引用存在性/类型检查）。
 * 按引用位期望的种类解析持久化 id：角色/地点是两个独立 id 空间，同 id 可在
 * 两桶共存，期望桶优先命中，不得因固定桶序误判种类。虚拟投影 id 不参与桶位
 * 命中（仅可经声明的 ref 别名解析——执行层只认别名表，直接放行投影 id 会
 * 落盘悬空绑定）。 */
export function entityScopeOf(st: EntityFoldHost): EntityTokenScope {
  return {
    kindOf: (token, expect) => {
      if (!st.virtualEntityIds.has(token)) {
        if (bucketOf(st, expect).has(token)) return expect
        const other = otherKind(expect)
        if (bucketOf(st, other).has(token)) return other
      }
      const ref = st.entityRefs.get(token)
      return ref === undefined ? null : ref.kind
    },
  }
}

/** 预览标签尾部的理由后缀（与 batchFold.reasonOf 同语义；独立副本避免环依赖）。 */
function reasonOf(cmd: Record<string, unknown>): string {
  const r = typeof cmd.reason === 'string' ? cmd.reason.trim() : ''
  return r ? `：${r}` : ''
}

/** fields 值形状检查：name 与本种类可选字段（character.bio / location.note）
 * 在场时须为字符串。 */
function appendShapeIssues(
  issues: string[],
  kind: EntityKind,
  fields: Record<string, unknown>,
): void {
  if (fields.name !== undefined && typeof fields.name !== 'string') issues.push('name 须为字符串')
  const optionalKey = kind === 'character' ? 'bio' : 'note'
  const optional = fields[optionalKey]
  if (optional !== undefined && typeof optional !== 'string') {
    issues.push(`${optionalKey} 须为字符串`)
  }
}

/** 创建模式：name 必填（trim 后非空）。 */
function appendCreateIssues(issues: string[], label: string, name: string): void {
  if (name === '') issues.push(`创建${label}须在 fields 提供 name`)
}

/** 修改模式：fields 不得为空；提供 name 时不得为空白（不许清空名称）。 */
function appendUpdateIssues(issues: string[], fields: Record<string, unknown>, name: string): void {
  const empty = Object.keys(fields).length === 0
  if (empty) issues.push('fields 为空')
  if (!empty && fields.name !== undefined && name === '') issues.push('name 不能为空白')
}

/** fields 白名单 + 值形状校验（信任边界）：白名单外字段拒绝；name 须非空白
 * 字符串（创建必填、修改不许清空）；可选字段须为字符串。返回错误文案或 null。 */
export function entityFieldsIssue(
  kind: EntityKind,
  fields: Record<string, unknown>,
  mode: 'create' | 'update',
): string | null {
  const allowed = AI_ENTITY_FIELDS[kind]
  const label = ENTITY_KIND_LABELS[kind]
  const unknownKeys = Object.keys(fields).filter((k) => !allowed.some((f) => f.key === k))
  if (unknownKeys.length > 0) {
    return `未知字段：${unknownKeys.join('、')}（${label} 允许：${allowed.map((f) => f.key).join('、')}）`
  }
  const issues: string[] = []
  appendShapeIssues(issues, kind, fields)
  const name = typeof fields.name === 'string' ? fields.name.trim() : ''
  if (mode === 'create') appendCreateIssues(issues, label, name)
  else appendUpdateIssues(issues, fields, name)
  return issues.length > 0 ? `实体字段错误：${issues.join('；')}` : null
}

/** fields 白名单键序归一：只保留输入中出现过的键（未提及字段不进执行命令，
 * 修改语义「未提及字段保持不变」由此在执行与重校验两侧同时成立——若给未
 * 提及的 name 注入空串，apply 期重校验会误判「name 不能为空白」整批确认
 * 失败，绕过重校验直执行则会把实体名清空）。name 去空白；可选字符串键保留。
 * 前置校验（entityFieldsIssue）通过后调用，值域可信；创建的 name 必填已在
 * 原始 fields 上把关，归一必得非空 name。 */
export function normalizeEntityFields(
  kind: EntityKind,
  fields: Record<string, unknown>,
): ValidatedEntityFields {
  const out: ValidatedEntityFields = {}
  for (const spec of AI_ENTITY_FIELDS[kind]) {
    const v = fields[spec.key]
    if (v === undefined) continue
    if (spec.key === 'name') out.name = typeof v === 'string' ? v.trim() : ''
    else if (typeof v === 'string') out[spec.key] = v
  }
  return out
}

/** entityId 解析结果：命中实体 id / 跨种类 / 未知。 */
type EntityTarget = { id: string } | 'missing' | 'cross'

/** ref 别名登记守卫（新建/修改两分支共用）：别名与既有实体 id 冲突时返回
 * 错误文案。校验期 token 解析以既有实体优先（entityScopeOf.kindOf 先查投影
 * 桶），执行期以别名表优先（batchSim 的 entityRefToId），冲突别名会让同一
 * token 在预览校验与执行解析到不同实体，产生跨种类误绑。 */
function entityRefCollisionIssue(st: EntityFoldHost, refName: string): string | null {
  if (st.characters.has(refName) || st.locations.has(refName)) {
    return `ref 别名不得与既有实体 id 相同（预览按既有实体解析、执行按别名解析，会产生不一致绑定）：${refName}`
  }
  return null
}

/** 修改目标解析：虚拟投影 id 不参与桶位命中（仅声明的 ref 别名可解析，
 * 同 entityScopeOf 口径——直接放行投影 id 会在执行期静默跳过）。 */
function resolveEntityTarget(st: EntityFoldHost, kind: EntityKind, token: string): EntityTarget {
  if (!st.virtualEntityIds.has(token) && bucketOf(st, kind).has(token)) return { id: token }
  const ref = st.entityRefs.get(token)
  if (ref !== undefined) {
    if (ref.kind !== kind) return 'cross'
    return { id: ref.id }
  }
  if (!st.virtualEntityIds.has(token) && bucketOf(st, otherKind(kind)).has(token)) return 'cross'
  return 'missing'
}

/** 新建分支（无 entityId）：虚拟 id 进投影，登记 ref 别名，产出 create_entity
 * 预览与命令；真实 id 与默认头像样式由应用在执行期分配。 */
function foldCreateEntity(
  st: EntityFoldHost,
  raw: Record<string, unknown>,
  index: number,
  kind: EntityKind,
  fields: Record<string, unknown>,
  refName: string,
): void {
  const issue = entityFieldsIssue(kind, fields, 'create')
  if (issue !== null) return st.fail(index, issue)
  const collision = refName !== '' ? entityRefCollisionIssue(st, refName) : null
  if (collision !== null) return st.fail(index, collision)
  const normalized = normalizeEntityFields(kind, fields)
  const label = ENTITY_KIND_LABELS[kind]
  const virtualId = virtualEntityIdOf(st, index)
  bucketOf(st, kind).set(virtualId, normalized.name)
  st.virtualEntityIds.add(virtualId)
  if (refName !== '') st.entityRefs.set(refName, { kind, id: virtualId })
  st.items.push({
    kind: 'create_entity',
    danger: false,
    key: `ec${index}`,
    label: `创建 ${label} · ${normalized.name}${reasonOf(raw)}`,
  })
  st.commands.push({
    op: `upsert_${kind}`,
    ...(refName !== '' ? { ref: refName } : {}),
    fields: normalized,
  } as ValidatedCommand)
}

/** 修改分支（带 entityId）：解析既有 id 或本批 ref（跨种类与未知拒绝），
 * 未提及字段保持不变。 */
function foldUpdateEntity(
  st: EntityFoldHost,
  raw: Record<string, unknown>,
  index: number,
  kind: EntityKind,
  fields: Record<string, unknown>,
  refName: string,
  target: string,
): void {
  const label = ENTITY_KIND_LABELS[kind]
  const issue = entityFieldsIssue(kind, fields, 'update')
  if (issue !== null) return st.fail(index, issue)
  const resolved = resolveEntityTarget(st, kind, target)
  if (resolved === 'cross') {
    return st.fail(
      index,
      `entityId 指向的是${ENTITY_KIND_LABELS[otherKind(kind)]}实体（须为${label}）：${target}`,
    )
  }
  if (resolved === 'missing') {
    return st.fail(index, `${label}实体不存在：${target}（修改须用设定集快照里的精确 id）`)
  }
  const collision = refName !== '' ? entityRefCollisionIssue(st, refName) : null
  if (collision !== null) return st.fail(index, collision)
  const normalized = normalizeEntityFields(kind, fields)
  const currentName = bucketOf(st, kind).get(resolved.id) ?? target
  if (normalized.name !== undefined) bucketOf(st, kind).set(resolved.id, normalized.name)
  if (refName !== '') st.entityRefs.set(refName, { kind, id: resolved.id })
  st.items.push({
    kind: 'update_entity',
    danger: false,
    key: `eu${index}`,
    label: `修改 ${label} · ${currentName}（${Object.keys(normalized).join('、')}）${reasonOf(raw)}`,
  })
  st.commands.push({
    op: `upsert_${kind}`,
    entityId: target,
    ...(refName !== '' ? { ref: refName } : {}),
    fields: normalized,
  } as ValidatedCommand)
}

/** upsert_character / upsert_location 的折叠校验：缺省 entityId = 新建（虚拟
 * id 进投影、应用在执行期分配真实 id 与默认样式）；带 entityId = 修改既有
 * 实体（未提及字段保持不变），本批新建的实体可经 ref 引用。entityId 在场
 * 但非字符串/空白 = 整批拒绝——畸形的修改意图不得重释为新建通道（否则
 * 改错实体的请求会静默变成重复实体），与设计「新建不带 entityId」同口径。 */
export function foldUpsert(
  st: EntityFoldHost,
  raw: Record<string, unknown>,
  index: number,
  kind: EntityKind,
): void {
  const fields = raw.fields
  if (!plainObject(fields)) return st.fail(index, 'fields 必须是字段对象')
  const refName = typeof raw.ref === 'string' ? raw.ref.trim() : ''
  if (raw.entityId === undefined) {
    return foldCreateEntity(st, raw, index, kind, fields, refName)
  }
  const target = typeof raw.entityId === 'string' ? raw.entityId.trim() : ''
  if (target === '') {
    // 诊断值经 JSON 序列化：Object 默认串化只会得到 "[object Object]"，
    // 模型无从得知自己发了什么；JSON 形态对五种原始/复合值都可读
    return st.fail(
      index,
      `entityId 在场时须为非空白字符串（缺省才是新建）：${JSON.stringify(raw.entityId)}`,
    )
  }
  foldUpdateEntity(st, raw, index, kind, fields, refName, target)
}

// ── 设定文档通道（issue 56，§9.3 upsert_document）────────────────────────

/** 文档 fields 白名单 + 值形状校验（阶段 A，上下文无关）：白名单外字段拒绝；
 * title/body 须为字符串；relatedIds 须为 {kind, id} 对象数组（裸字符串项、
 * 未知 kind、缺失/空 id 拒绝，§9.3）。创建 title 必填；修改不许清空 title。 */
export function documentFieldsIssue(
  fields: Record<string, unknown>,
  mode: 'create' | 'update',
): string | null {
  const unknownKeys = Object.keys(fields).filter(
    (k) => !AI_DOCUMENT_FIELDS.some((f) => f.key === k),
  )
  if (unknownKeys.length > 0) {
    return `未知字段：${unknownKeys.join('、')}（文档 允许：${AI_DOCUMENT_FIELDS.map((f) => f.key).join('、')}）`
  }
  const issues: string[] = []
  if (fields.title !== undefined && typeof fields.title !== 'string') issues.push('title 须为字符串')
  if (fields.body !== undefined && typeof fields.body !== 'string') issues.push('body 须为字符串')
  appendRelatedIdsIssues(issues, fields.relatedIds)
  const title = typeof fields.title === 'string' ? fields.title.trim() : ''
  if (mode === 'create' && title === '') issues.push('创建文档须在 fields 提供 title')
  if (mode === 'update') {
    if (Object.keys(fields).length === 0) issues.push('fields 为空')
    else if (fields.title !== undefined && title === '') issues.push('title 不能为空白')
  }
  return issues.length > 0 ? `文档字段错误：${issues.join('；')}` : null
}

/** relatedIds 条目形状检查（阶段 A）：数组且每项为 {kind, id} 完整对。 */
function appendRelatedIdsIssues(issues: string[], related: unknown): void {
  if (related === undefined) return
  if (!Array.isArray(related)) {
    issues.push('relatedIds 须为数组')
    return
  }
  related.forEach((item, i) => {
    if (!plainObject(item)) {
      issues.push(`relatedIds[${i}] 须为 {kind, id} 对象`)
      return
    }
    const { kind, id } = item as Record<string, unknown>
    if (kind !== 'character' && kind !== 'location') {
      issues.push(`relatedIds[${i}].kind 须为 character 或 location`)
    } else if (typeof id !== 'string' || id.trim() === '') {
      issues.push(`relatedIds[${i}].id 须为非空白字符串`)
    }
  })
}

/** fields 白名单键序归一（同 normalizeEntityFields 口径）：只保留输入中出现
 * 过的键；title 去空白；relatedIds 保持原始 token（既有 id 或本批 ref 别名），
 * 执行期由 batchSim 别名表解析——临时别名不落盘。前置校验通过后调用。 */
export function normalizeDocumentFields(
  fields: Record<string, unknown>,
): ValidatedDocumentFields {
  const out: ValidatedDocumentFields = {}
  if (typeof fields.title === 'string') out.title = fields.title.trim()
  if (typeof fields.body === 'string') out.body = fields.body
  if (Array.isArray(fields.relatedIds)) {
    out.relatedIds = (fields.relatedIds as Array<Record<string, unknown>>).map((item) => ({
      kind: item.kind as 'character' | 'location',
      id: item.id as string,
    }))
  }
  return out
}

/** relatedIds 存在性与种类校验（阶段 B）：token 按条目 kind 解析（既有实体
 * 或本批 ref 别名）；解析结果去重——裸重复与别名/显式 id 指向同一实体都拒绝。
 * 快照未携带设定集时跳过存在性校验（与实体引用位同口径，旧夹具兼容）。
 * 返回 null = 已整批拒绝。 */
function resolveRelatedIds(
  st: EntityFoldHost,
  index: number,
  related: unknown,
): ValidatedDocumentFields['relatedIds'] | null {
  if (!Array.isArray(related)) return []
  const out: Array<{ kind: EntityKind; id: string }> = []
  const seen = new Set<string>()
  for (const [i, item] of related.entries()) {
    const entry = item as Record<string, unknown>
    const kind = entry.kind as EntityKind
    const id = entry.id as string
    if (st.entityScope !== undefined) {
      const actual = st.entityScope.kindOf(id, kind)
      if (actual === null) {
        st.fail(index, `relatedIds[${i}] 引用的${ENTITY_KIND_LABELS[kind]}实体不存在：${id}`)
        return null
      }
      if (actual !== kind) {
        st.fail(index, `relatedIds[${i}] 指向的是${ENTITY_KIND_LABELS[actual]}实体（kind 写了 ${ENTITY_KIND_LABELS[kind]}）：${id}`)
        return null
      }
    }
    const resolved = st.entityRefs.get(id)?.id ?? id
    const key = `${kind}:${resolved}`
    if (seen.has(key)) {
      st.fail(index, `relatedIds 重复关联同一实体：${ENTITY_KIND_LABELS[kind]} ${id}`)
      return null
    }
    seen.add(key)
    out.push({ kind, id })
  }
  return out
}

/** 文档新建（无 entityId）：fields 白名单/形状校验 + relatedIds 解析；
 * 真实 id 由应用在执行期分配。 */
function foldCreateDocument(
  st: EntityFoldHost,
  raw: Record<string, unknown>,
  index: number,
  fields: Record<string, unknown>,
): void {
  const issue = documentFieldsIssue(fields, 'create')
  if (issue !== null) return st.fail(index, issue)
  if (resolveRelatedIds(st, index, fields.relatedIds) === null) return
  const normalized = normalizeDocumentFields(fields)
  st.items.push({
    kind: 'create_entity',
    danger: false,
    key: `ed${index}`,
    label: `创建 文档 · ${normalized.title}${reasonOf(raw)}`,
  })
  st.commands.push({ op: 'upsert_document', fields: normalized })
}

/** 文档修改（带 entityId）：精确解析 documents 桶（角色/地点实体同 id 不算
 * 命中——三个独立 id 空间，期望桶优先），未提及字段保持不变。 */
function foldUpdateDocument(
  st: EntityFoldHost,
  raw: Record<string, unknown>,
  index: number,
  fields: Record<string, unknown>,
  target: string,
): void {
  const issue = documentFieldsIssue(fields, 'update')
  if (issue !== null) return st.fail(index, issue)
  const currentTitle = st.documents.get(target)
  if (currentTitle === undefined) {
    if (st.characters.has(target) || st.locations.has(target)) {
      return st.fail(index, `entityId 指向的是角色/地点实体（须为文档）：${target}`)
    }
    return st.fail(index, `文档不存在：${target}（修改须用设定集快照里的精确 id）`)
  }
  if (resolveRelatedIds(st, index, fields.relatedIds) === null) return
  const normalized = normalizeDocumentFields(fields)
  if (normalized.title !== undefined) st.documents.set(target, normalized.title)
  st.items.push({
    kind: 'update_entity',
    danger: false,
    key: `eu${index}`,
    label: `修改 文档 · ${currentTitle}（${Object.keys(normalized).join('、')}）${reasonOf(raw)}`,
  })
  st.commands.push({ op: 'upsert_document', entityId: target, fields: normalized })
}

/** upsert_document 的折叠校验（issue 56）：缺省 entityId = 新建（执行期分配
 * 真实 id）；带 entityId = 修改既有文档。entityId 在场但非字符串/空白 = 整批
 * 拒绝（同 foldUpsert 口径——畸形修改意图不得重释为新建通道）。 */
export function foldUpsertDocument(
  st: EntityFoldHost,
  raw: Record<string, unknown>,
  index: number,
): void {
  const fields = raw.fields
  if (!plainObject(fields)) return st.fail(index, 'fields 必须是字段对象')
  if (raw.entityId === undefined) return foldCreateDocument(st, raw, index, fields)
  const target = typeof raw.entityId === 'string' ? raw.entityId.trim() : ''
  if (target === '') {
    return st.fail(
      index,
      `entityId 在场时须为非空白字符串（缺省才是新建）：${JSON.stringify(raw.entityId)}`,
    )
  }
  foldUpdateDocument(st, raw, index, fields, target)
}
