/**
 * 设定集四桶的归一化（§11.1 第 2/3 步，§6 设定模型）：容器与成员形状、
 * relatedIds 判别、实体必填字段校验、空记录键与角色安全子值域的重发，
 * 以及重发后同桶结构化引用（characterIds/speaker/locationId/assetId/
 * relatedIds）与对白文本提及 token 的同步改写。
 */
import { isPlainObject, plainObjectEntries } from './jsonGuards'
import { uid } from '../uid'
import type { StoryNode } from './document'

const SETTINGS_BUCKETS = ['characters', 'locations', 'props', 'documents'] as const

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
export function normalizeSettingsBuckets(
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
export function reKeyBlankEntries(
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

/** 各桶「旧键 → 新键」重发映射集合（空键与角色安全子值域重发共用）：
 * characters/locations 来自设定桶，assets 来自资产索引。 */
export interface BlankKeyRemaps {
  characters: Map<string, string>
  locations: Map<string, string>
  assets: Map<string, string>
}

/** 角色 id 的文本语法子值域（§6，五十九轮）：`@[character:<id>]` token 的
 * `<id>` 不得含 `]`、空白等分隔字符，须完整匹配 ASCII 安全字符集。 */
export const SAFE_CHARACTER_ID = /^[A-Za-z0-9_-]{1,64}$/

/** 角色桶的非安全记录键重发（§11.1 第 3 步「角色 id/token 专项修复」，
 * 空白键已由 reKeyBlankEntries 处理）：键违反 `[A-Za-z0-9_-]{1,64}` 时
 * 重发本桶未占用的安全键、值内 id 随键同步，返回「旧键 → 新键」映射供
 * 结构化引用与文本 token 改写——不安全身份无法由固定 token 语法表示。 */
export function reKeyUnsafeCharacterKeys(
  record: Record<string, Record<string, unknown>>,
  warnings: string[],
): Map<string, string> {
  const remap = new Map<string, string>()
  for (const key of Object.keys(record)) {
    if (!key.trim() || SAFE_CHARACTER_ID.test(key)) continue
    let fresh = uid('ch')
    while (fresh in record) fresh = uid('ch')
    const entry = record[key]
    delete record[key]
    record[fresh] = entry
    entry.id = fresh
    remap.set(key, fresh)
    warnings.push(
      `settings.characters 键 ${key} 不满足角色 id 安全字符集（[A-Za-z0-9_-]{1,64}），已重发新键 ${fresh}`,
    )
  }
  return remap
}

/** 场景节点的空键引用改写：characterIds 数组项与 locationId。空键重发
 * 映射改写后仍空白且无映射的引用（§8.1 共同值域之外、不可恢复）直接
 * 移除——原样进会话只会显示成虚构的「已删除引用」并被原样落盘。 */
function rewriteSceneBlankRefs(
  nid: string,
  spec: Record<string, unknown>,
  remaps: BlankKeyRemaps,
  warnings: string[],
): void {
  if (Array.isArray(spec.characterIds)) {
    const remapped = (spec.characterIds as unknown[]).map((cid, i) =>
      rewriteRef(remaps.characters, cid, `节点 ${nid} 的 characterIds[${i}]`, warnings),
    )
    const kept = remapped.filter((cid) => !(typeof cid === 'string' && !cid.trim()))
    if (kept.length !== remapped.length) {
      warnings.push(`节点 ${nid} 的 characterIds 含无映射可改写的空白引用，已移除`)
    }
    spec.characterIds = kept
  }
  if ('locationId' in spec) {
    spec.locationId = rewriteRef(remaps.locations, spec.locationId, `节点 ${nid} 的 locationId`, warnings)
    if (typeof spec.locationId === 'string' && !spec.locationId.trim()) {
      warnings.push(`节点 ${nid} 的 locationId 为无映射可改写的空白引用，已移除`)
      delete spec.locationId
    }
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
    // 空键重发改写后仍空白且无映射（§8.1 共同值域之外、不可恢复）直接
    // 移除——与场景/分镜路径同口径：原样保留只会展示/落盘虚构的
    // 「已删除说话人」引用
    if (typeof line.speaker === 'string' && !line.speaker.trim()) {
      warnings.push(`节点 ${nid} 的对白行 ${i} speaker 为无映射可改写的空白引用，已移除`)
      delete line.speaker
    }
  }
}

/** 分镜节点的空键引用改写（§11.1 六十四轮）：assetId 只按资产索引解析——
 * 引用位的唯一命名空间是 assets.byId，不再按 kind 分派设定集桶。
 * 空白 assetId 的唯一合法出路是指向空键资产（随重发改写）；无映射的空白
 * 引用不可解析，装上画布即永久悬空——在此移除并警告（AI 边界同口径拒绝，
 * 见 ai/commands.ts 的 isShotRefMember）。 */
function rewriteShotBlankRefs(
  nid: string,
  spec: Record<string, unknown>,
  remaps: BlankKeyRemaps,
  warnings: string[],
): void {
  if (!Array.isArray(spec.refs)) return
  const kept: unknown[] = []
  for (const ref of spec.refs as unknown[]) {
    if (!isPlainObject(ref) || !('assetId' in ref)) {
      kept.push(ref)
      continue
    }
    const next = rewriteRef(remaps.assets, ref.assetId, `节点 ${nid} 的分镜引用 ${String(ref.id)}`, warnings)
    if (typeof next === 'string' && !next.trim()) {
      warnings.push(`节点 ${nid} 的分镜引用 ${String(ref.id)} 的 assetId 空白且无空键资产映射，已移除`)
      continue
    }
    ref.assetId = next
    kept.push(ref)
  }
  spec.refs = kept
}

/** 对白文本中的 @ 提及 token 字面量改写（§8.1.2/五十九轮）：随角色 id
 * 重发同步——旧 id 可能含 `]`、换行等，不得用新 token 正则扫描，须按
 * 已知旧身份构造完整字面量 `@[character:<旧 id>]`，以 split/join 的
 * 字面量匹配替换为新 token。 */
export function rewriteCharacterMentionTokens(
  nodes: StoryNode[],
  remaps: Map<string, string>,
  warnings: string[],
): void {
  if (remaps.size === 0) return
  for (const n of nodes) {
    if (n.type !== 'dialogue') continue
    for (const line of n.data.spec.lines) {
      if (typeof line.text !== 'string') continue
      line.text = replaceMentionLiterals(line.text, remaps, n.id, warnings)
    }
  }
}

/** 单段文本的字面量 token 替换内核。 */
function replaceMentionLiterals(
  text: string,
  remaps: Map<string, string>,
  nid: string,
  warnings: string[],
): string {
  let out = text
  for (const [oldId, newId] of remaps) {
    if (!oldId) continue
    const literal = `@[character:${oldId}]`
    if (!out.includes(literal)) continue
    out = out.split(literal).join(`@[character:${newId}]`)
    warnings.push(`节点 ${nid} 的对白文本提及 token 已随角色 id 重发改写`)
  }
  return out
}

/** 设定文档 relatedIds 的空键改写（§11.1 第 3 步，六十六轮）：按 kind
 * 对应桶改写（禁止跨命名空间）；改写后仍指向空白 id 且无对应重发的项
 * 移除并警告。 */function rewriteDocumentBlankRefs(
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
 * 字段（场景 characterIds/locationId、对白 speaker、分镜 assetId、图片
 * outputs.primary.assetId、角色 avatarAssetId、设定文档 relatedIds 按
 * kind 对应桶）随重发改写到新 id 而非变悬空——脏写引用侧同样可出现空串。 */
export function rewriteBlankKeyReferences(
  nodes: StoryNode[],
  settings: Record<string, Record<string, unknown>>,
  remaps: BlankKeyRemaps,
  warnings: string[],
): void {
  for (const n of nodes) {
    // 边界（issue 16）：加载管线内 spec 仍是被 JSON 擦除类型的联合，此处
    // 只做引用字段的重发改写，字段域由各 rewrite*BlankRefs 谓词背书
    const spec = n.data.spec as unknown as Record<string, unknown>
    if (n.type === 'scene') rewriteSceneBlankRefs(n.id, spec, remaps, warnings)
    if (n.type === 'dialogue') rewriteDialogueBlankRefs(n.id, spec, remaps.characters, warnings)
    if (n.type === 'shot') rewriteShotBlankRefs(n.id, spec, remaps, warnings)
    if (n.type === 'image') rewriteImageBlankRefs(n.id, spec, remaps.assets, warnings)
  }
  for (const [key, ch] of Object.entries(settings.characters) as [string, Record<string, unknown>][]) {
    if (!('avatarAssetId' in ch)) continue
    ch.avatarAssetId = rewriteRef(remaps.assets, ch.avatarAssetId, `角色 ${key} 的 avatarAssetId`, warnings)
    // 空键重发改写后仍空白且无映射（§8.1 共同值域之外、不可恢复）直接
    // 移除——与场景/对白/分镜路径同口径：原样保留只会每次加载警告悬空、
    // 原样落盘，恢复不了非空白 id 不变量
    if (typeof ch.avatarAssetId === 'string' && !ch.avatarAssetId.trim()) {
      warnings.push(`角色 ${key} 的 avatarAssetId 为无映射可改写的空白引用，已移除`)
      delete ch.avatarAssetId
    }
  }
  rewriteDocumentBlankRefs(settings, remaps, warnings)
}

/** 图片节点产物引用的空键改写（§8.1/§13）：outputs.primary.assetId 指向
 * 空白键资产时随重发改写到新 id；改写后仍空白且无映射（真悬空的空引用）
 * 剥离 primary——与角色 avatarAssetId、分镜引用同口径。 */
function rewriteImageBlankRefs(
  nid: string,
  spec: Record<string, unknown>,
  assetRemap: Map<string, string>,
  warnings: string[],
): void {
  const outputs = spec.outputs
  if (!isPlainObject(outputs)) return
  const primary = outputs.primary
  if (!isPlainObject(primary) || typeof primary.assetId !== 'string') return
  const next = rewriteRef(assetRemap, primary.assetId, `节点 ${nid} 的图片产物引用`, warnings)
  if (typeof next === 'string' && !next.trim()) {
    warnings.push(`节点 ${nid} 的图片产物引用空白且无空键资产映射，已剥离`)
    delete outputs.primary
    return
  }
  primary.assetId = next
}

/** 设定集实体形状校验（§11.3）：必填字段无法机械修复的条目从桶中隔离并警告
 * （否则 name: null 之类的值交付画布后，头像渲染的 trim 在运行期崩溃），
 * 既有引用按 §8.2.3 悬空标记；记录键为权威 id，内嵌 id 缺失或漂移以键改写
 * （与 assets.byId 同域）。documents 桶按 §6 判别必填 title/body。 */
export function normalizeEntityShapes(
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
