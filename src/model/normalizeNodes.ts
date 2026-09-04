/**
 * 节点与边的成员级判别联合校验与键控列表修复（§11.1 第 2/3 步，§4.1/§4.2）：
 * 嵌套容器（data/spec/meta/layout + position）形状、never 禁写字段剥离、
 * spec 必填标量判定、必填列表的容器修复/异型成员过滤/键控 id 重发、
 * 对白行可选字段收口、编号顺位重发——无法机械修复的成员隔离。
 */
import { isPlainObject } from './jsonGuards'
import { uid } from '../uid'
import type { StoryEdge, StoryNode } from './document'

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

/** 对白行 speaker 域收口（§4.2，供 normalizeDialogueLineOptionals 调用）：
 * action 行携带 speaker（契约只允许 line 行有说话人——AI 边界已拒新输入，
 * 此为加载/导入侧的对等收口）或异型（非角色 id 字符串）均剥离并警告；
 * null 是 v0 兼容链「无说话人」的合法产物，按缺省保留。 */
function stripIllegalSpeaker(
  line: Record<string, unknown>,
  nid: string,
  lid: string,
  warnings: string[],
): void {
  const speaker = line.speaker
  if (speaker === undefined || speaker === null) return
  const action = line.kind === 'action'
  if (!action && typeof speaker === 'string') return
  warnings.push(`节点 ${nid} 的对白行 ${lid} 的 speaker ${action ? '为 action 行携带（只允许 line 行有说话人）' : '异型（须为角色 id 字符串）'}，已剥离`)
  delete line.speaker
}

/** 对白行可选字段的值域修复（§4.2 DialogueLine，与 AI 命令边界
 * speaker/side/vo 同域）：异型字段确定性剥离并警告——对象 speaker 会进
 * <select>、真值字符串 vo 会渲染 VO 徽标；speaker 域收口见
 * stripIllegalSpeaker。 */
function normalizeDialogueLineOptionals(
  spec: Record<string, unknown>,
  nid: string,
  warnings: string[],
): void {
  if (!Array.isArray(spec.lines)) return
  for (const line of spec.lines as Record<string, unknown>[]) {
    const lid = typeof line.id === 'string' && line.id ? line.id : '(缺失 id)'
    stripIllegalSpeaker(line, nid, lid, warnings)
    if (line.side !== undefined && line.side !== 'left' && line.side !== 'right') {
      warnings.push(`节点 ${nid} 的对白行 ${lid} 的 side 异型（须为 left/right），已剥离`)
      delete line.side
    }
    if (line.vo !== undefined && typeof line.vo !== 'boolean') {
      warnings.push(`节点 ${nid} 的对白行 ${lid} 的 vo 异型（须为布尔），已剥离`)
      delete line.vo
    }
  }
}

const NODE_TYPES = new Set(['scene', 'beat', 'dialogue', 'branch', 'shot', 'image'])

/** 名称型节点（§4.1 LabeledMeta）：meta.label 必填。 */
const LABELED_TYPES = new Set(['scene', 'beat', 'dialogue'])

/** spec 类型相关必填标量（§4.2 判别联合）：编号 sceneNo/shotNo 可顺位重发、
 * 必填列表可确定性置空，均不在此判定；此处只收无法机械修复的标量。 */
const REQUIRED_SCALARS: Record<string, Record<string, 'string' | 'boolean'>> = {
  scene: { interior: 'boolean', synopsis: 'string' },
  beat: { tone: 'string' },
  branch: { prompt: 'string' },
  shot: { size: 'string', picture: 'string', prompt: 'string' },
  image: { prompt: 'string', model: 'string', size: 'string' },
}

/** never 禁写 meta 字段剥离（§4.1 DerivedMeta/ShotMeta/ImageMeta）：
 * branch/shot/image 不落 label 镜像；分镜卡随宿主场景分集、图片节点非
 * 叙事单元，均无独立 episodeNo。 */
function stripForbiddenMeta(
  type: string,
  meta: Record<string, unknown>,
  nid: string,
  warnings: string[],
): void {
  if ((type === 'branch' || type === 'shot' || type === 'image') && 'label' in meta) {
    warnings.push(`节点 ${nid} 携带 never 禁写的 meta.label，已剥离`)
    delete meta.label
  }
  if ((type === 'shot' || type === 'image') && 'episodeNo' in meta) {
    warnings.push(`节点 ${nid} 携带 never 禁写的 meta.episodeNo（不参与大纲分组），已剥离`)
    delete meta.episodeNo
  }
}

/** meta.episodeNo 值域（§4.1/§9.3 同域：安全整数且 > 0）：非法删除该字段
 * 回退未分集，不阻断加载。 */
function normalizeEpisodeNo(meta: Record<string, unknown>, nid: string, warnings: string[]): void {
  if (!('episodeNo' in meta)) return
  const ep = meta.episodeNo
  if (typeof ep !== 'number' || !Number.isSafeInteger(ep) || ep <= 0) {
    warnings.push(`节点 ${nid} 的 meta.episodeNo 非法，已删除（回退未分集）`)
    delete meta.episodeNo
  }
}

/** 场景自由文本字段的就地修复与形态校验（§4.2/§11.1，SceneNode 渲染安全）：
 * time 在存储契约中为可选缺省，但运行态 SceneNodeData.time 是必填字符串且
 * SceneNode 无条件渲染——缺失确定性置空串并警告；非字符串值（形态错位，如
 * time: {}）会被当成 React 子节点渲染而崩溃，返回隔离原因。可选 weather 的
 * 非字符串值是真值，同样会被条件渲染成 React 子节点——剥离该字段并警告，
 * 节点本体保留。返回 null 表示通过。 */
function normalizeSceneTextFields(
  spec: Record<string, unknown>,
  nid: string,
  warnings: string[],
): string | null {
  if ('weather' in spec && typeof spec.weather !== 'string') {
    warnings.push(`节点 ${nid} 的 spec.weather 非字符串，已剥离`)
    delete spec.weather
  }
  if (!('time' in spec)) {
    spec.time = ''
    warnings.push(`节点 ${nid} 的 spec.time 缺失，已置空串`)
    return null
  }
  if (typeof spec.time !== 'string') return 'spec.time 类型错误（spec 形态错位）'
  return null
}

/** 图片节点 outputs 槽位的就地修复（§13 ImageSpec，nodeDiscriminantError
 * 调用）：容器缺失/非普通对象重置为空对象并警告（未生成产物是合法状态
 * `outputs: {}`，缺失即脏写）；primary 异型（非普通对象、assetId 非字符
 * 串）剥离整个 primary 并警告（半损坏的产物引用没有消费价值）；空白
 * assetId 不在此剥离——它可能指向空键资产，交由空键重发改写域处理
 * （rewriteImageBlankRefs，§8.1），无映射的悬空空白才在该域剥离。宽高
 * 存在但非正有限数时剥离该字段（演进占位字段的值域收口）。 */
function normalizeImageOutputs(
  spec: Record<string, unknown>,
  nid: string,
  warnings: string[],
): void {
  if (!isPlainObject(spec.outputs)) {
    warnings.push(`节点 ${nid} 的 spec.outputs 缺失或非对象，已重置为空对象`)
    spec.outputs = {}
    return
  }
  const primary = spec.outputs.primary
  if (primary !== undefined) {
    if (!isPlainObject(primary) || typeof primary.assetId !== 'string') {
      warnings.push(`节点 ${nid} 的 outputs.primary 异型，已剥离`)
      delete spec.outputs.primary
    } else {
      for (const dim of ['width', 'height'] as const) {
        const v = primary[dim]
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
          warnings.push(`节点 ${nid} 的 outputs.primary.${dim} 非法，已剥离`)
          delete primary[dim]
        }
      }
    }
  }
}

/** 节点判别联合形状校验（§11.1 第 3 步节点校验细则——§4.1 联合在加载路径的
 * 对等兜底，JSON 边界已擦除 TS 类型）：never 禁写字段剥离、episodeNo 非法
 * 删除为就地修复；未知类型、spec 必填标量缺失/异型（形态错位，如 beat 的
 * tone 为对象——交付画布后被当 React 子节点渲染而崩溃）、名称型节点缺必填
 * meta.label 等无法机械修复的形态返回隔离原因；null 表示通过。 */
function nodeDiscriminantError(
  member: Record<string, unknown>,
  nid: string,
  warnings: string[],
): string | null {
  const type = member.type
  const data = member.data as { spec: Record<string, unknown>; meta: Record<string, unknown> }
  if (typeof type !== 'string' || !NODE_TYPES.has(type)) {
    return `未知节点类型 ${String(type)}`
  }
  stripForbiddenMeta(type, data.meta, nid, warnings)
  if (LABELED_TYPES.has(type) && typeof data.meta.label !== 'string') {
    return '缺必填 meta.label'
  }
  normalizeEpisodeNo(data.meta, nid, warnings)
  if (type === 'scene') {
    // 可选引用 locationId 非字符串（脏写/导入）就地剥离：原样进会话会
    // 直达设置面板的 <select> 并被序列化原样落盘，归一化永远修不回来
    if ('locationId' in data.spec && typeof data.spec.locationId !== 'string') {
      warnings.push(`节点 ${nid} 的 spec.locationId 非字符串，已剥离`)
      delete data.spec.locationId
    }
    const textIssue = normalizeSceneTextFields(data.spec, nid, warnings)
    if (textIssue) return textIssue
  }
  if (type === 'image') normalizeImageOutputs(data.spec, nid, warnings)
  for (const [field, kind] of Object.entries(REQUIRED_SCALARS[type] ?? {})) {
    if (typeof data.spec[field] !== kind) return `spec.${field} 缺失或类型错误（spec 形态错位）`
  }
  return null
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
function ensureRequiredListContainer(
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
function filterListMembers(
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
function repairKeyedListIds(
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

/** 可选布局数值字段归一化（§4.1/§11.1 节点校验细则，与 §9.3 create_node
 * 边界同域）：size 存在时须为普通对象且 width/height 为正有限数，zIndex
 * 存在时须为有限数——非法即剥离该字段并警告（节点本体保留，回退默认尺寸/
 * 层级），合法字段双向保留，不随打开-保存丢失。 */
function normalizeLayoutOptionals(layout: Record<string, unknown>, nid: string, warnings: string[]): void {
  if ('size' in layout) {
    const size = layout.size
    const w = isPlainObject(size) ? size.width : undefined
    const h = isPlainObject(size) ? size.height : undefined
    const ok =
      typeof w === 'number' && Number.isFinite(w) && w > 0 &&
      typeof h === 'number' && Number.isFinite(h) && h > 0
    if (!ok) {
      warnings.push(`节点 ${nid} 的 layout.size 非法（须为普通对象且 width/height 为正有限数），已剥离`)
      delete layout.size
    }
  }
  if ('zIndex' in layout && (typeof layout.zIndex !== 'number' || !Number.isFinite(layout.zIndex))) {
    warnings.push(`节点 ${nid} 的 layout.zIndex 非法（须为有限数），已剥离`)
    delete layout.zIndex
  }
}

/** 单个节点的成员形状校验与机械修复；嵌套容器（data/spec/meta/layout +
 * position 坐标）或判别联合形状（§4.1/§4.2）无法机械修复时隔离该节点
 * （返回 null）。 */
export function normalizeNode(
  member: unknown,
  warnings: string[],
  optionIdRemap: Map<string, Map<string, string>>,
): StoryNode | null {
  if (!isPlainObject(member)) {
    warnings.push('graph.nodes 中的非普通对象成员已隔离')
    return null
  }
  const nid = typeof member.id === 'string' && member.id ? member.id : '(缺失 id)'
  const data = member.data
  const layout = member.layout
  if (
    !isPlainObject(data) ||
    !isPlainObject(data.spec) ||
    !isPlainObject(data.meta) ||
    !isPlainObject(layout)
  ) {
    warnings.push(`节点 ${nid} 的 data/spec/meta/layout 容器缺失或异型，无法机械修复，已隔离`)
    return null
  }
  const pos = layout.position
  if (!isPlainObject(pos) || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
    warnings.push(`节点 ${nid} 的 layout.position 坐标非法，无法机械修复，已隔离`)
    return null
  }
  normalizeLayoutOptionals(layout, nid, warnings)
  // §11.1 第 3 步顺序契约：键控列表身份分析先于异型成员过滤与判别隔离
  ensureRequiredListContainer(data.spec, member.type, nid, warnings)
  repairKeyedListIds(member, data.spec, nid, warnings, optionIdRemap)
  filterListMembers(data.spec, member.type, nid, warnings)
  if (member.type === 'dialogue') normalizeDialogueLineOptionals(data.spec, nid, warnings)
  const shapeError = nodeDiscriminantError(member, nid, warnings)
  if (shapeError) {
    warnings.push(`节点 ${nid} 的判别形状非法（${shapeError}），已隔离`)
    return null
  }
  const ui = member.ui
  if (!isPlainObject(ui) || typeof ui.selected !== 'boolean' || typeof ui.expanded !== 'boolean') {
    warnings.push(`节点 ${nid} 的 ui 缺失或异型，已重置为默认值`)
    member.ui = { selected: false, expanded: true }
  }
  return member as unknown as StoryNode
}

/** 单个边的成员形状校验：非普通对象或判别依据 data 缺失即无法机械修复，隔离（返回 null）。
 * data.order 存在时须为有限数（§5，先于端点/kind 处理）：异型值确定性剥离
 * 并警告——order 只影响同端点边的展示排序，剥离不改变连接语义，边保留。 */
export function normalizeEdge(member: unknown, warnings: string[]): StoryEdge | null {
  if (!isPlainObject(member)) {
    warnings.push('graph.edges 中的非普通对象成员已隔离')
    return null
  }
  if (!isPlainObject(member.data)) {
    warnings.push(
      `边 ${typeof member.id === 'string' && member.id ? member.id : '(缺失 id)'} 的 data 缺失或异型，已隔离`,
    )
    return null
  }
  if (member.data.order !== undefined && !Number.isFinite(member.data.order)) {
    warnings.push(
      `边 ${typeof member.id === 'string' && member.id ? member.id : '(缺失 id)'} 的 data.order 非有限数，已剥离`,
    )
    delete member.data.order
  }
  return member as unknown as StoryEdge
}

/** 场景/分镜编号顺位重发（§4.2 sceneNo/shotNo 值域：正的安全整数）：编号
 * 非法（非数、非整数、≤ 0、越界）时按文档序取本类型内最小未占用正整数
 * 并警告——编号仅作展示序号，重发不触碰任何引用；合法编号保留，包括重复。 */
export function renumberSeqFields(nodes: StoryNode[], warnings: string[]): void {
  const used: Record<'scene' | 'shot', Set<number>> = { scene: new Set(), shot: new Set() }
  for (const n of nodes) {
    if (n.type !== 'scene' && n.type !== 'shot') continue
    const key = n.type === 'scene' ? 'sceneNo' : 'shotNo'
    const spec = n.data.spec as unknown as Record<string, unknown>
    const cur = spec[key]
    if (typeof cur === 'number' && Number.isSafeInteger(cur) && cur > 0) {
      used[n.type].add(cur)
      continue
    }
    let next = 1
    while (used[n.type].has(next)) next += 1
    used[n.type].add(next)
    spec[key] = next
    warnings.push(`节点 ${n.id} 的 spec.${key} 非法（须为正的安全整数），已按文档序顺位重发为 ${next}`)
  }
}
