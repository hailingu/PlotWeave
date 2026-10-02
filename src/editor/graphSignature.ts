/**
 * 画布语义内容签名（纯函数）：节点/连线/设定集中可持久化字段的稳定
 * 序列化，剥离 React Flow 会话态（selected/dragging/measured/className）
 * 与纯样式类——与序列化层（convert.ts 只存语义字段）同口径。
 *
 * 用途：useDebouncedSave 的置脏判定——纯选择/拖拽过程帧与纯样式类注入
 * 不改变签名，不触发防抖保存。AI 执行卡的恢复对账改用画布文档内的
 * `graph.aiRevision` 提交计数（§12.2），不再依赖签名比较。
 */
import type { Edge } from '@xyflow/react'
import type { ProjectSettings } from './settings'
import type { CanvasNode } from './nodes/types'

/** 剥离运行态字段后的浅拷贝（与序列化层同口径，见 useDebouncedSave）。 */
function stripRuntime(item: object, keys: string[]): Record<string, unknown> {
  const rest = { ...item } as Record<string, unknown>
  for (const key of keys) delete rest[key]
  return rest
}

const NODE_RUNTIME_KEYS = ['selected', 'dragging', 'measured', 'className']
const EDGE_RUNTIME_KEYS = ['selected', 'className']

/** 逐项签名缓存（issue #272）：以节点/连线对象为键——React Flow 与命令
 * 层以新对象表达变化（补丁路径都产新引用），同一对象恒同一语义。拖拽
 * 过程帧只替换被拖节点，其余项命中缓存，每帧序列化开销从 O(图大小)
 * 降为 O(变化项)。WeakMap 随对象回收。 */
const NODE_SIG = new WeakMap<object, string>()
const EDGE_SIG = new WeakMap<object, string>()

function cachedItemSig(
  cache: WeakMap<object, string>,
  item: object,
  keys: string[],
): string {
  const hit = cache.get(item)
  if (hit !== undefined) return hit
  const sig = JSON.stringify(stripRuntime(item, keys))
  cache.set(item, sig)
  return sig
}

/** 画布语义签名：同一语义内容恒得同一字符串。字面与整体
 * `JSON.stringify({ nodes, edges, settings })` 完全一致（逐项 JSON 以
 * `,` 拼接等价于数组序列化），仅计算路径改为逐项缓存。 */
export function graphSignature(
  nodes: CanvasNode[],
  edges: Edge[],
  settings: ProjectSettings,
): string {
  const nodesJson = nodes
    .map((n) => cachedItemSig(NODE_SIG, n, NODE_RUNTIME_KEYS))
    .join(',')
  const edgesJson = edges
    .map((e) => cachedItemSig(EDGE_SIG, e, EDGE_RUNTIME_KEYS))
    .join(',')
  const settingsJson: string | undefined = JSON.stringify(settings)
  // settings 为 undefined 时 JSON.stringify 整体对象会省略该键，保持一致
  const settingsPart =
    settingsJson === undefined ? '' : `,"settings":${settingsJson}`
  return `{"nodes":[${nodesJson}],"edges":[${edgesJson}]${settingsPart}}`
}
