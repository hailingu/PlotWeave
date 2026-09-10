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

/** 画布语义签名：同一语义内容恒得同一字符串。 */
export function graphSignature(
  nodes: CanvasNode[],
  edges: Edge[],
  settings: ProjectSettings,
): string {
  return JSON.stringify({
    nodes: nodes.map((n) => stripRuntime(n, ['selected', 'dragging', 'measured', 'className'])),
    edges: edges.map((e) => stripRuntime(e, ['selected', 'className'])),
    settings,
  })
}
