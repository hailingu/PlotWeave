/**
 * 资产索引 assets.byId 的归一化（§11.3 / §7.1，Rust 保存边界的加载侧对等）
 * 与分镜 refs 旧草案 targetId 的无歧义兼容子步骤（六十四轮）：完整
 * AssetRef 形状校验（relPath 词法/规范 MIME/source/严格 ISO 8601）、
 * 记录键权威 id 改写、实路径复验失败键隔离，以及修复前后身份快照。
 */
import { isPlainObject } from './jsonGuards'

/** MIME token 字符集（与 Rust is_mime_token 同域）：RFC 7230 token 减去
 * `*`——通配符是能力标记而非具体文件类型，Rust 保存边界刻意排除；加载侧
 * 若放行 `image/*` 之类的条目，此后每次 save_project 都被保存边界整份
 * 拒收（防抖吞错，用户编辑永不落盘），须在此同域隔离。 */
function isMimeToken(s: string): boolean {
  return /^[A-Za-z0-9!#$%&'+.^_`|~-]+$/.test(s)
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
export function isStrictIso8601(s: string): boolean {
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
export function normalizeAssetRecords(
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
    // createdAt 统一落为 UTC toISOString()（§7.1）：带显式时区的合法表示
    // 确定性规范化并警告——同一瞬间只保留一种持久化表示；规范化越出
    // 四位年份域（极端偏移换算出扩张年表示）时无规范形可落，而保存边界
    // 只收 24 字符规范 UTC——该条目按不可恢复隔离并警告，留存即令此后
    // 每次保存/修复回写都注定失败、重试永久排队
    const canon = new Date(entry.createdAt as string).toISOString()
    if (!isStrictIso8601(canon)) {
      warnings.push(`资产 ${key} 的 createdAt 规范化越出四位年份域（无规范 UTC 形可落），已隔离`)
      delete byId[key]
      continue
    }
    if (canon !== entry.createdAt) {
      warnings.push(`资产 ${key} 的 createdAt 已规范化为 UTC ISO 8601`)
      entry.createdAt = canon
    }
  }
}

/** 改写前身份捕获（六十四轮 targetId 兼容的「修复前身份」输入）：以条目
 * 对象引用记录每条记录的原始记录键与原始内嵌 id（非空白字符串时）——
 * 空键重发与角色安全子值域重发都会改写记录键并同步内嵌 id，须在一切
 * 键/id 改写前捕获；否则旧 targetId 指向的被重发实体/资产在兼容判定时
 * 查无此身份：歧义引用被误转为资产，或本可唯一命中的资产被误隔离。 */
export function capturePreRepairIds(
  record: Record<string, Record<string, unknown>>,
): Map<Record<string, unknown>, Set<string>> {
  const captured = new Map<Record<string, unknown>, Set<string>>()
  for (const [key, entry] of Object.entries(record)) {
    const ids = new Set<string>()
    if (key.trim()) ids.add(key)
    if (typeof entry.id === 'string' && entry.id.trim()) ids.add(entry.id)
    captured.set(entry, ids)
  }
  return captured
}

/** 桶成员身份快照（六十四轮 targetId 兼容的「修复前后的身份」判定）：记录
 * 每条记录的最终键、改写前捕获的原始身份与当前内嵌 id——判定时再按桶当前
 * 成员过滤（e.key in bucket），已被隔离的条目不参与命中。 */
export interface IdentitySnapshot {
  key: string
  ids: Set<string>
}

/** 捕获桶内每条记录的身份集合：最终记录键 + 改写前身份 + 当前内嵌 id。 */
export function identitySnapshot(
  record: Record<string, Record<string, unknown>>,
  preRepair: Map<Record<string, unknown>, Set<string>>,
): IdentitySnapshot[] {
  return Object.entries(record).map(([key, entry]) => {
    const ids = new Set(preRepair.get(entry) ?? [])
    ids.add(key)
    if (typeof entry.id === 'string' && entry.id.trim()) ids.add(entry.id)
    return { key, ids }
  })
}
/** targetId 兼容判定的输入面：修复后的设定桶/资产索引（当前成员身份）、
 * 修复前身份快照与资产空键重发映射。 */
export interface LegacyTargetIdCtx {
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
export function compatLegacyShotTargetIds(
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
