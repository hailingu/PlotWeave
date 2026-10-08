import { useStore } from '@xyflow/react'

/** 订阅当前句柄连接的选中边；绑定稳定 ID，双向端口共享同一激活依据。 */
export function usePortActive(
  nodeId: string,
  type: 'source' | 'target',
  handleId?: string,
): boolean {
  return useStore((state) =>
    state.edges.some((edge) => {
      const endpoint = type === 'source' ? edge.source : edge.target
      const handle = type === 'source' ? edge.sourceHandle : edge.targetHandle
      return (
        edge.selected === true &&
        endpoint === nodeId &&
        (handle ?? null) === (handleId ?? null)
      )
    }),
  )
}
