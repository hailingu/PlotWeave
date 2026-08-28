/**
 * 画布落盘序列化（EditorView 持久化路径的纯函数部分）。
 * React Flow 运行态字段（selected/measured/dragging/className 等）不持久——
 * 只存语义字段，保证文档文件稳定、可 diff。
 */
import type { Edge } from '@xyflow/react'
import type { CanvasNode } from './nodes/types'

/** 落盘时剥离 React Flow 运行态字段，只存持久语义。 */
export function stripNode(n: CanvasNode): CanvasNode {
  return { id: n.id, type: n.type, position: n.position, data: n.data } as CanvasNode
}

/** 边的持久字段：端点 + 条件携带的端口/类型/样式/数据。 */
export function stripEdge(e: Edge): Edge {
  const out: Edge = { id: e.id, source: e.source, target: e.target }
  if (e.sourceHandle) out.sourceHandle = e.sourceHandle
  if (e.type) out.type = e.type
  if (e.className) out.className = e.className
  if (e.data !== undefined) out.data = e.data
  return out
}
