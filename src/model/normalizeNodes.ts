/**
 * 节点与边的成员级判别联合校验（§11.1 第 2/3 步，§4.1/§4.2）：嵌套容器
 * （data/spec/meta/layout + position）形状、never 禁写字段剥离、spec 必填
 * 标量判定、对白行可选字段收口、编号顺位重发——无法机械修复的成员隔离。
 * 必填键控列表的容器/成员/id 修复在同目录 normalizeKeyedLists.ts
 * （issue #39 拆分）。
 */
import { isPlainObject } from './jsonGuards'
import {
  ensureRequiredListContainer,
  filterListMembers,
  repairKeyedListIds,
} from './normalizeKeyedLists'
import type { StoryEdge, StoryNode } from './document'

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

/** 校验通过的落盘成员 → StoryNode 判别联合的唯一构造出口（§4.1，issue 16）：
 * JSON 边界已擦除 TS 类型，形状契约由 normalizeNode 全量背书——嵌套容器、
 * 判别联合形状（nodeDiscriminantError）、键控列表修复、never 禁写剥离、
 * ui 补齐全部通过后，此处才把 Record 绑定为联合成员；cast 收口于此，
 * 调用点不得再散布裸转换。 */
function validatedStoryNode(member: Record<string, unknown>): StoryNode {
  return member as unknown as StoryNode
}

/** 校验通过的落盘成员 → StoryEdge 判别联合的唯一构造出口（§5，issue 16）：
 * kind 句柄契约与 order 值域由 normalizeEdge 背书，绑定收口于此。 */
function validatedStoryEdge(member: Record<string, unknown>): StoryEdge {
  return member as unknown as StoryEdge
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
  return validatedStoryNode(member)
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
  return validatedStoryEdge(member)
}

/** 场景/分镜编号顺位重发（§4.2 sceneNo/shotNo 值域：正的安全整数）：编号
 * 非法（非数、非整数、≤ 0、越界）时按文档序取本类型内最小未占用正整数
 * 并警告——编号仅作展示序号，重发不触碰任何引用；合法编号保留，包括重复。 */
export function renumberSeqFields(nodes: StoryNode[], warnings: string[]): void {
  const used: Record<'scene' | 'shot', Set<number>> = { scene: new Set(), shot: new Set() }
  for (const n of nodes) {
    if (n.type !== 'scene' && n.type !== 'shot') continue
    const key = n.type === 'scene' ? 'sceneNo' : 'shotNo'
    // 边界（issue 16）：加载管线内 spec 仍是被 JSON 擦除类型的联合，此处
    // 只做编号值域的读改写，字段域由 REQUIRED_SCALARS/renumber 规则背书
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
