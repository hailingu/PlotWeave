import type { BatchIssue, PreviewItem, ValidatedCommand, ValidatedEntityFields } from './commands'
import {
  AI_ENTITY_FIELDS,
  ENTITY_KIND_LABELS,
  type EntityKind,
  type EntityTokenScope,
} from './entityFields'
import { plainObject } from './patchShape'

/**
 * AI 设定实体命令（upsert_character / upsert_location）的折叠校验实现域
 * （issue 44）：与 batchFold.ts 的节点折叠同一语义——在「当前设定集 +
 * 本批已建/已改」的虚拟投影上完成 fields 白名单/值形状校验、entityId 解析
 * （既有 id 或本批 ref 别名）与 ref 登记，产出预览条目与已校验命令。
 * 修改必须精确指向 id（名称只作展示，绝不作为定位或覆盖依据）；失败的
 * upsert 登记 ghost 实体，依赖其 ref 的引用按 contingent 跳过（同节点
 * ref 依赖，见 batchFold.registerFailedMutation）。
 */

/** 折叠期新建实体的虚拟 id（不进设定集，仅同批 ref 解析与 contingent 判定用）。 */
const virtualEntityIdOf = (index: number): string => `__ent__:${index}`

/** 折叠器共享的实体状态与收集器（batchFold.FoldState 经此接口消费）。 */
export interface EntityFoldHost {
  /** 既有 + 本批投影的实体 id → 名称（新建为虚拟 id，执行期才分配真实 id）。 */
  characters: Map<string, string>
  locations: Map<string, string>
  /** ref 别名 → 所属实体（kind + id；新建指向虚拟 id）。 */
  entityRefs: Map<string, { kind: EntityKind; id: string }>
  /** 本批失败的 upsert 虚拟实体 id：依赖其 ref 的引用按 contingent 跳过。 */
  ghostEntities: Set<string>
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

/** 实体 token 解析口径：快照给批次校验消费（patchShape 的引用存在性/类型检查）。 */
export function entityScopeOf(st: EntityFoldHost): EntityTokenScope {
  return {
    kindOf: (token) => {
      if (st.characters.has(token)) return 'character'
      if (st.locations.has(token)) return 'location'
      const ref = st.entityRefs.get(token)
      if (ref === undefined) return null
      if (st.ghostEntities.has(ref.id)) return 'contingent'
      return ref.kind
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

/** 白名单键序归一：name 去空白，可选字符串键保留。前置校验（entityFieldsIssue）
 * 通过后调用，值域可信。 */
export function normalizeEntityFields(
  kind: EntityKind,
  fields: Record<string, unknown>,
): ValidatedEntityFields {
  const out: ValidatedEntityFields = {}
  for (const spec of AI_ENTITY_FIELDS[kind]) {
    const v = fields[spec.key]
    if (spec.key === 'name') out.name = typeof v === 'string' ? v.trim() : ''
    else if (typeof v === 'string') out[spec.key] = v
  }
  return out
}

/** entityId 解析结果：命中实体 id / 跨种类 / 未知 / 依赖失败前序（contingent）。 */
type EntityTarget = { id: string } | 'missing' | 'cross' | 'contingent'

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

function resolveEntityTarget(st: EntityFoldHost, kind: EntityKind, token: string): EntityTarget {
  if (bucketOf(st, kind).has(token)) return { id: token }
  const ref = st.entityRefs.get(token)
  if (ref !== undefined) {
    if (ref.kind !== kind) return 'cross'
    if (st.ghostEntities.has(ref.id)) return 'contingent'
    return { id: ref.id }
  }
  if (bucketOf(st, otherKind(kind)).has(token)) return 'cross'
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
  const virtualId = virtualEntityIdOf(index)
  bucketOf(st, kind).set(virtualId, normalized.name)
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

/** 修改分支（带 entityId）：解析既有 id 或本批 ref（contingent 跳过、跨种类
 * 与未知拒绝），未提及字段保持不变。 */
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
  if (resolved === 'contingent') return
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

/** upsert_character / upsert_location 的折叠校验：不带 entityId = 新建（虚拟
 * id 进投影、应用在执行期分配真实 id 与默认样式）；带 entityId = 修改既有
 * 实体（未提及字段保持不变），本批新建的实体可经 ref 引用。 */
export function foldUpsert(
  st: EntityFoldHost,
  raw: Record<string, unknown>,
  index: number,
  kind: EntityKind,
): void {
  const fields = raw.fields
  if (!plainObject(fields)) return st.fail(index, 'fields 必须是字段对象')
  const refName = typeof raw.ref === 'string' ? raw.ref.trim() : ''
  const target = typeof raw.entityId === 'string' ? raw.entityId.trim() : ''
  if (target === '') return foldCreateEntity(st, raw, index, kind, fields, refName)
  foldUpdateEntity(st, raw, index, kind, fields, refName, target)
}

/** 失败 upsert 的依赖登记（batchFold.registerFailedMutation 调用）：ref 指向
 * ghost 虚拟实体，后续引用按 contingent 跳过，随前序修复自愈。 */
export function registerFailedEntityUpsert(
  st: EntityFoldHost,
  raw: Record<string, unknown>,
  index: number,
): void {
  const refName = typeof raw.ref === 'string' ? raw.ref.trim() : ''
  if (refName === '') return
  const kind: EntityKind = raw.op === 'upsert_character' ? 'character' : 'location'
  const virtualId = virtualEntityIdOf(index)
  st.entityRefs.set(refName, { kind, id: virtualId })
  st.ghostEntities.add(virtualId)
}
