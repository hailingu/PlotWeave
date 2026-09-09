/**
 * 必填键控列表的修复内核（§11.1 第 2/3 步，issue #39 自 normalizeNodes.ts
 * 拆出）：缺失/非数组容器确定性置空、成员形状判别与异型过滤、键控成员 id
 * 的空白/重复重发与 branch 空选项句柄映射。指向被清空选项的连线由孤儿边
 * 规则处理；节点判别联合校验与编排入口见 normalizeNodes.ts。
 */
import { isPlainObject } from './jsonGuards'
import { uid } from '../uid'

/** 按节点类型的必填列表（§4.2 spec 契约）：缺失/非数组可确定性置空，
 * 所属节点保留；指向被清空选项的连线由孤儿边规则处理。 */
const REQUIRED_LISTS: Record<string, string> = {
  scene: 'characterIds',
  dialogue: 'lines',
  branch: 'options',
  shot: 'refs',
}

/** 对白行成员形状（§4.2 DialogueLine）：判别字段 kind ∈ line/action 且
 * text 必填字符串——text 异型的行进会话后会被 DialogueNode 当 React 子节点
 * 渲染而崩溃，一行坏行不应阻挡整个项目画布打开。id 缺失不致命（列表 key
 * 退化但不崩溃），旧格式的 id 回填由迁移链（legacy.ts）负责，不在此判别。
 * 可选字段（speaker/side/vo）的值域由 normalizeDialogueLineOptionals 在
 * 成员过滤后逐字段剥离，不在此判别（字段异型不连累整行文本）。 */
function isDialogueLineShape(item: unknown): boolean {
  if (!isPlainObject(item)) return false
  if (item.kind !== 'line' && item.kind !== 'action') return false
  return typeof item.text === 'string'
}

/** 键控列表成员 id 的非法原因（§8.1 共同值域：非空字符串）。 */
function keyedIdIssue(id: unknown): string {
  if (typeof id !== 'string') return '非字符串'
  if (!id.trim()) return '缺失或空白'
  return '重复'
}

const KEYED_LIST_PREFIX: Record<string, string> = { lines: 'line', options: 'opt', refs: 'ref' }

/** 键控列表成员中空白字符串 id 的原值计数（「空 id → 新 id」映射的唯一性
 * 判定：同一空白原值仅出现一次时映射明确）。非对象成员无 id 可计。 */
function blankIdCounts(list: unknown[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of list) {
    if (!isPlainObject(item)) continue
    const id = item.id
    if (typeof id === 'string' && !id.trim()) {
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  return counts
}

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
  // 在未过滤列表上运行（§11.1 顺序：身份分析先于异型成员过滤）——非对象
  // 成员不占身份位（无 id 可占），原样留给后续过滤
  const blankCounts = blankIdCounts(list)
  const seen = new Set<string>()
  const remap = new Map<string, string>()
  for (const item of list) {
    if (!isPlainObject(item)) continue
    const id = item.id
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
    item.id = fresh
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
 * 在此放行，由随后的资产空键重发改写兜底；无空键映射的空白引用在改写阶段
 * 移除（§11.1 第 3 步）；旧草案 targetId 已由兼容子步骤先行转换或隔离，
 * 到达此处即异型。 */
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

/** 必填列表的容器修复（§11.1 第 2 步）：缺失/非数组确定性置空，所属
 * 节点保留；成员过滤由 filterListMembers 在键控 id 分析之后执行。 */
export function ensureRequiredListContainer(
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
  }
}

/** 必填列表的异型成员过滤（§11.1 第 3 步，**在键控 id 分析之后**——首见
 * 成员即使随后被此过滤移除，其 id 也已在身份分析中占据首见位，后见同 id
 * 成员持新 id、指向原 id 的连线按孤儿边隔离而非被继承）；指向被清空
 * 选项的连线由孤儿边规则处理。 */
export function filterListMembers(
  spec: Record<string, unknown>,
  type: unknown,
  nid: string,
  warnings: string[],
): void {
  const listKey = REQUIRED_LISTS[type as string]
  if (!listKey) return
  const list = spec[listKey]
  if (!Array.isArray(list)) return
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
export function repairKeyedListIds(
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
