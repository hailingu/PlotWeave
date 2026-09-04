/**
 * 边的 id 修复与隔离规则（§11.1 第 3 步 / §11.3 / §5）：空端点与空选项
 * 句柄的同步改写、匿名端口句柄剥离、孤儿边判定、重复节点/边 id 重发、
 * 剧情流成环与 attach 宿主唯一隔离、逻辑重复边隔离。
 */
import { branchOptionIdOf, SCENE_SHOT_HANDLE } from '../editor/graphRules'
import { isPlainObject } from './jsonGuards'
import { uid } from '../uid'
import type { BranchEdge, BranchSpec, StoryEdge, StoryNode } from './document'

/** 孤儿边判定（§11.3）：端点节点缺失；branch 边绑定的选项已不存在；
 * attach 边句柄非字面量 shots（无法确定性修复）；attach 边端点类型不合法
 * （必须 scene → shot）；剧情流边端点为 shot（§4.2 分镜卡不参与横向剧情流）
 * 或 source 为 branch（§5 端口归属反向约束——branch 无匿名输出端口）
 * 同论。句柄可剥离的矛盾形态已在 stripAlienHandles 阶段处理，不在此隔离。 */
export function isOrphanEdge(e: StoryEdge, nodesById: Map<string, StoryNode>): boolean {
  const src = nodesById.get(e.source)
  const dst = nodesById.get(e.target)
  if (!src || !dst) return true
  if (e.data.kind === 'attach') {
    if (e.sourceHandle !== SCENE_SHOT_HANDLE) return true
    return src.type !== 'scene' || dst.type !== 'shot'
  }
  // 剧情流端点约束：分镜卡与图片节点不参与横向剧情流（§4.2/§13——
  // 图片节点是自由摆放的生成产物，不经边挂接）
  if (src.type === 'shot' || dst.type === 'shot' || src.type === 'image' || dst.type === 'image') {
    return true
  }
  // §5 端口归属反向约束：branch 无匿名输出端口，不能引出 sequence 边
  if (e.data.kind === 'sequence' && src.type === 'branch') return true
  if (e.data.kind !== 'branch') return false
  if (src.type !== 'branch') return true
  const optionId = branchOptionIdOf(e.sourceHandle)
  const options = (src.data.spec as BranchSpec).options
  return optionId === undefined || !options.some((o) => o.id === optionId)
}

/** branch 边类型谓词：嵌套 data.kind 不能直接窄化联合，显式谓词供句柄改写使用。 */
function isBranchEdge(e: StoryEdge): e is BranchEdge {
  return e.data.kind === 'branch'
}

/** 空节点 id 重发后的边端点改写（§11.1 第 3 步）：空字符串可被脏写的
 * source/target 指向，唯一空 id 节点的映射明确、端点同步改写为新 id、
 * 连线保留；无映射（多个空 id 节点歧义，或端点值非空 id 串）时保持原值，
 * 随孤儿边规则隔离。 */
export function rewriteBlankNodeEndpoints(
  e: StoryEdge,
  nodeIdRemap: Map<string, string>,
  warnings: string[],
): StoryEdge {
  const source = nodeIdRemap.get(e.source)
  const target = nodeIdRemap.get(e.target)
  if (source === undefined && target === undefined) return e
  const out = { ...e }
  if (source !== undefined) {
    out.source = source
    warnings.push(`边 ${e.id} 的 source 指向已重发的空节点 id，已改写为 ${source}`)
  }
  if (target !== undefined) {
    out.target = target
    warnings.push(`边 ${e.id} 的 target 指向已重发的空节点 id，已改写为 ${target}`)
  }
  return out
}

/** 空选项 id 重发后的引出边句柄改写（§11.1 第 3 步）：branch 的空选项 id
 * 在键控列表修复中重发且映射唯一（同一空白原值仅出现一次）时，option- 句柄
 * 指向原空 id 的边同步改写为新 id，避免改接丢失；无明确映射（歧义多次出现）
 * 的句柄不改写，随选项 id 重发失效后按孤儿边隔离。 */
export function rewriteRemappedOptionHandles(
  e: StoryEdge,
  optionIdRemap: Map<string, Map<string, string>>,
  warnings: string[],
): StoryEdge {
  // option- 句柄只在 branch 边上有意义；attach/sequence 的异型句柄由
  // stripAlienHandles / 孤儿边规则处理，不在此改写
  if (!isBranchEdge(e)) return e
  const handle = e.sourceHandle
  if (typeof handle !== 'string' || !handle.startsWith('option-')) return e
  const mapped = optionIdRemap.get(e.source)?.get(handle.slice('option-'.length))
  if (mapped === undefined) return e
  warnings.push(`边 ${e.id} 的句柄 ${handle} 指向已重发的空选项 id，已改写为 option-${mapped}`)
  return { ...e, sourceHandle: `option-${mapped}` }
}

/** 已知 kind 边的确定性句柄剥离（§5）：匿名端口唯一，targetHandle 与
 * sequence 的 sourceHandle 无法绑定真实端口——剥离不改变连接语义，
 * 记录警告而不隔离。未知/非字符串 kind 无法判定变体，直接隔离并警告
 * （绝不为未知 kind 猜测变体）。 */
export function stripAlienHandles(e: StoryEdge, warnings: string[]): StoryEdge | null {
  const kind = (e.data as { kind?: unknown }).kind
  if (kind !== 'sequence' && kind !== 'branch' && kind !== 'attach') {
    warnings.push(`已隔离边 ${e.id}：data.kind 未知或非字符串`)
    return null
  }
  const out = { ...e }
  if (out.targetHandle !== undefined) {
    warnings.push(`边 ${e.id} 的 targetHandle 无法绑定匿名端口，已剥离`)
    delete out.targetHandle
  }
  if (kind === 'sequence' && (out as { sourceHandle?: string }).sourceHandle !== undefined) {
    warnings.push(`sequence 边 ${e.id} 的 sourceHandle 无法绑定匿名端口，已剥离`)
    delete (out as { sourceHandle?: string }).sourceHandle
  }
  // branch/attach 的 sourceHandle 承载连接语义（选项出口 / shots 端口），
  // JSON 边界擦除类型后的非字符串值无法剥离修复（剥离即改接语义），隔离该边
  const sh = (out as { sourceHandle?: unknown }).sourceHandle
  if ((kind === 'branch' || kind === 'attach') && sh !== undefined && typeof sh !== 'string') {
    warnings.push(`已隔离边 ${e.id}：${kind} 边的 sourceHandle 非字符串，无法绑定端口`)
    return null
  }
  return out
}

/** 节点 id 的非法原因（§8.1 共同值域：非空字符串）。 */
function nodeIdIssue(id: unknown): string {
  if (typeof id !== 'string') return '缺失或非字符串'
  if (!id.trim()) return '缺失或空白'
  return '重复'
}

/** 非法/重复节点 id 修复（§11.1 第 3 步，**先于判别形状隔离**）：id 缺失、
 * 非字符串或空白一律重发本域未占用的新 id——非法身份交付画布会令 React
 * Flow 渲染/选中/删除歧义；合法 id 重复保留文档序首个、后续重发（按 id
 * 的引用本就解析到首见项，重发节点成无连线孤儿由用户处置，不产生改接）。
 * 顺序契约：首见节点随后因形状非法被隔离时，后见同 id 节点已持新 id——
 * 指向原 id 的边按孤儿边隔离，而非静默改接到后见节点。空 id 重发时建立
 * 「空 id → 新 id」映射供边端点改写——同一空 id 串仅一个节点持有时映射
 * 唯一、连线保留；多个节点同空 id 映射歧义则不建映射，指向空串的边随
 * 孤儿边规则隔离。非对象成员原样放行（占位身份无从谈起，后续形状隔离）。 */
export function reissueDuplicateNodeIds(
  members: unknown[],
  warnings: string[],
): { members: unknown[]; nodeIdRemap: Map<string, string> } {
  const blankCounts = new Map<string, number>()
  for (const m of members) {
    if (isPlainObject(m) && typeof m.id === 'string' && !m.id.trim()) {
      blankCounts.set(m.id, (blankCounts.get(m.id) ?? 0) + 1)
    }
  }
  const seen = new Set<string>()
  const nodeIdRemap = new Map<string, string>()
  const out = members.map((m) => {
    if (!isPlainObject(m)) return m
    if (typeof m.id === 'string' && m.id.trim() && !seen.has(m.id)) {
      seen.add(m.id)
      return m
    }
    let fresh = uid('node')
    while (seen.has(fresh)) fresh = uid('node')
    seen.add(fresh)
    if (typeof m.id === 'string' && !m.id.trim() && blankCounts.get(m.id) === 1) {
      nodeIdRemap.set(m.id, fresh)
    }
    const shown = typeof m.id === 'string' && m.id.trim() ? `${m.id} ` : ''
    warnings.push(
      `节点 id ${shown}${nodeIdIssue(m.id)}：已重发新 id ${fresh}（合法 id 重复保留文档序首个，引用仍解析到首见节点）`,
    )
    return { ...m, id: fresh }
  })
  return { members: out, nodeIdRemap }
}

/** 重复/非法边 id 修复（§11.1 第 3 步，与节点 id 同款规则）：保留文档序
 * 首条，后续同 id 边重发本域未占用的新 id 并警告；缺失、非字符串或空白
 * id（§8.1 共同值域：trim 后非空——空白串真值非空但 React Flow 身份不可靠，
 * 选中/删除/撤销会命中错误边）同款重发。边 id 不被任何数据引用（端点/句柄
 * 只指向节点与选项），重发无副作用；身份唯一后 React Flow 的选中/删除
 * 不再歧义。 */
export function reissueDuplicateEdgeIds(edges: StoryEdge[], warnings: string[]): StoryEdge[] {
  const seen = new Set<string>()
  return edges.map((e) => {
    if (typeof e.id === 'string' && e.id.trim() && !seen.has(e.id)) {
      seen.add(e.id)
      return e
    }
    let fresh = uid('edge')
    while (seen.has(fresh)) fresh = uid('edge')
    seen.add(fresh)
    const reason = typeof e.id === 'string' && e.id.trim() ? `边 id ${e.id} 重复` : '边 id 缺失或非法'
    warnings.push(`${reason}：保留文档序首条原 id，后续边已重发新 id ${fresh}`)
    return { ...e, id: fresh }
  })
}

/** 已接受剧情流边中 from 是否可达 to（BFS 传递闭包，§4.3 DAG 不变量）。 */
function flowReaches(adj: Map<string, string[]>, from: string, to: string): boolean {
  const seen = new Set([from])
  const queue = [from]
  while (queue.length > 0) {
    const cur = queue.pop() as string
    for (const next of adj.get(cur) ?? []) {
      if (next === to) return true
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return false
}

/** 剧情流成环隔离（§11.1 第 3 步）：候选边按文档序逐边重建剧情流图，
 * 自环（source === target）与加入即闭合回路的 sequence/branch 边按孤儿边
 * 隔离并警告；attach 垂直从属不参与环检测（§4.3）。 */
export function isolateCycleEdges(edges: StoryEdge[], warnings: string[]): StoryEdge[] {
  const adj = new Map<string, string[]>()
  const kept: StoryEdge[] = []
  for (const e of edges) {
    if (e.data.kind === 'attach') {
      kept.push(e)
      continue
    }
    if (e.source === e.target) {
      warnings.push(`已隔离自环边 ${e.id}：source 与 target 相同`)
      continue
    }
    if (flowReaches(adj, e.target, e.source)) {
      warnings.push(`已隔离成环边 ${e.id}：加入后剧情流闭合回路（${e.target} 已可达 ${e.source}）`)
      continue
    }
    const list = adj.get(e.source)
    if (list) list.push(e.target)
    else adj.set(e.source, [e.target])
    kept.push(e)
  }
  return kept
}

/** attach 宿主唯一（§5/§11.1 第 3 步）：同一 shot 至多一条入向 attach 边
 * （分集归属与下挂布局的唯一依据）——保留文档序首条，其余按孤儿边隔离并警告。 */
export function isolateExtraAttachHosts(edges: StoryEdge[], warnings: string[]): StoryEdge[] {
  const hosted = new Set<string>()
  const kept: StoryEdge[] = []
  for (const e of edges) {
    if (e.data.kind !== 'attach') {
      kept.push(e)
      continue
    }
    if (hosted.has(e.target)) {
      warnings.push(`已隔离多余的 attach 边 ${e.id}：分镜 ${e.target} 已有宿主场景（宿主唯一）`)
      continue
    }
    hosted.add(e.target)
    kept.push(e)
  }
  return kept
}

/** 逻辑重复边隔离（§11.3）：同 source/target/sourceHandle 的边保留文档序首条，
 * 其余按孤儿边隔离并警告——并行重复边会被 React Flow 重叠渲染，
 * 图遍历与统计也把同一关系重复计数。元组键用 JSON 编码：source/target
 * 是不可信输入，JSON 字符串可含任意分隔字符（含 \u0000）——拼接键会让
 * 不同端点的边折叠成同键、被误判重复并随修复回写永久移除。 */
export function isolateDuplicateEdges(edges: StoryEdge[], warnings: string[]): StoryEdge[] {
  const seen = new Set<string>()
  return edges.filter((e) => {
    const key = JSON.stringify([e.source, e.target, e.sourceHandle ?? ''])
    if (seen.has(key)) {
      warnings.push(`已隔离重复边 ${e.id}：与既有边同 source/target/sourceHandle（逻辑重复）`)
      return false
    }
    seen.add(key)
    return true
  })
}
