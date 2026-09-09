/**
 * 画布语义内容签名（纯函数）：节点/连线/设定集中可持久化字段的稳定
 * 序列化，剥离 React Flow 会话态（selected/dragging/measured/className）
 * 与纯样式类——与 useDebouncedSave 的置脏判定同口径。
 *
 * 用途：AI 执行卡的恢复对账。批次在内存执行后，若承载它的画布文档尚未
 * 确认落盘，会话里保存的卡片是待执行状态 + 执行前的画布签名；重开时把
 * 该签名与当前画布比对即可判定批次是否已随画布落盘——一致 = 未落盘，
 * 恢复为可再次执行的待执行卡；不一致 = 画布已含该批改动，恢复为历史
 * 执行卡，避免在已应用的画布上重复执行同一批次。
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
