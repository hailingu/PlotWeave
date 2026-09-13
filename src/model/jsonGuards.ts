/**
 * 归一化管线共享的 JSON 边界形状谓词与规范化比较（§11 前端模型层）。
 * JSON 解析已擦除 TypeScript 类型，各阶段模块共用这里的普通对象判别、
 * 空原型记录承接与键序无关的语义比较；不依赖任何框架。
 */

/** 普通对象：JSON 边界排除了 TypeScript 类型，数组也是 object 须显式排除。 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 信封透传容器的契约键清单（issue #100 同版本文档字段演进策略）：
 * graph/settings/assets 容器以 untyped 值经 Rust 透传，容器级未知键按
 * 扩展字段无损保留——归一化捕获（normalizeContainers）与序列化还原
 * （fromDocument）共用同一清单，防止两处键域漂移。顶层与 project 层是
 * 类型化封闭契约（未知键在 IPC 前即被剥离），不在保留范围。 */
export const GRAPH_CONTRACT_KEYS = ['nodes', 'edges', 'viewport', 'aiRevision'] as const
export const SETTINGS_CONTRACT_KEYS = ['characters', 'locations', 'props', 'documents'] as const
export const ASSETS_CONTRACT_KEYS = ['byId'] as const

/** 捕获容器中契约键之外的扩展键（值原样引用：JSON 解析产物无别名，且
 * 归一化只沿契约键就地改写，扩展值不会被管线触碰）。空原型记录承接：
 * JSON 允许 `__proto__` 作为普通键（JSON.parse 产出自有属性），普通对象
 * 字面量赋值会触发原型 setter 丢失条目（与 plainObjectEntries 同口径）。 */
export function extensionEntries(
  container: Record<string, unknown>,
  contractKeys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  for (const [key, value] of Object.entries(container)) {
    if (!contractKeys.includes(key)) out[key] = value
  }
  return out
}

/** 确定性码点序比较器（规范化产物须跨环境一致，非 locale 相关：
 * localeCompare 会随 ICU 数据漂移）。 */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** 递归按键序排序的规范化视图（空原型记录承接 `__proto__` 等合法键——
 * 普通对象字面量赋值会触发原型 setter 丢失条目，键控桶同款口径）。 */
function sortedDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortedDeep)
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = Object.create(null)
    for (const k of Object.keys(v).sort(byCodeUnit)) out[k] = sortedDeep(v[k])
    return out
  }
  return v
}

/** 「归一化是否改写了内容」的语义比较（键序无关、数组保序、值逐项相等）。
 * normalizeDocument 就地改写传入对象（id 重发/字段剥离等），调用方必须
 * 先克隆原始文档再比较——对改写后的同一批对象自比较永远相等。 */
export function sameCanonicalJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortedDeep(a)) === JSON.stringify(sortedDeep(b))
}

/** 普通键值对象的成员过滤：非普通对象（含数组——下标 "0"/"1" 会被误当权威实体 id）
 * 整体重置为空 Record，桶内异型条目移除；缺失视为空，不警告。
 * 返回空原型记录（Object.create(null) 逐项赋值）：`__proto__` 是合法 id
 * （安全字符集允许下划线），普通 {} 赋值会触发原型 setter——条目不进
 * Object.entries/Object.values 而静默丢失；空原型上 `__proto__` 赋值直接成为
 * own 属性。同时 `constructor`/`toString` 等原型链键名不再误命中
 * Object.prototype 成员（否则按键查找拿到非条目值，下游如 mime.startsWith
 * 直接抛 TypeError，悬空引用漏报且文档打不开）。 */
export function plainObjectEntries(
  v: unknown,
  label: string,
  warnings: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  if (!isPlainObject(v)) {
    if (v !== undefined) warnings.push(`${label} 非普通键值对象，已重置为空 Record`)
    return out
  }
  for (const [k, item] of Object.entries(v)) {
    if (isPlainObject(item)) out[k] = item
    else warnings.push(`${label} 的条目 ${k} 不是普通对象，已移除`)
  }
  return out
}
