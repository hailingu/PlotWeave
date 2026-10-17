import { Handle, Position } from '@xyflow/react'
import { useCallback, useRef } from 'react'

import { usePortActive } from './usePortActive'
import { invalidateHandleQueries } from './handleQueryCache'

/** 外置连接端口：圆形输入与居中箭头方形输出，保留 React Flow 的连接与命中语义。 */
export function NodePort({
  nodeId,
  type,
  position,
  id,
  label,
  className = '',
}: {
  readonly nodeId: string
  readonly type: 'source' | 'target'
  readonly position: Position
  readonly id?: string
  readonly label: string
  readonly className?: string
}) {
  const active = usePortActive(nodeId, type, id)
  const currentHandle = useRef<HTMLDivElement | null>(null)
  /** React's null ref releases removed ports; a stable callback leaves ordinary renders untouched. */
  const bindHandle = useCallback((handle: HTMLDivElement | null): void => {
    const previous = currentHandle.current
    currentHandle.current = handle
    if (previous && previous !== handle) invalidateHandleQueries([previous])
  }, [])
  return (
    <Handle
      ref={bindHandle}
      type={type}
      position={position}
      {...(id !== undefined && { id })}
      className={`pw-port ${className}${active ? ' pw-port-active' : ''}`}
      data-pw-port={type === 'source' ? 'out' : 'in'}
      role="group"
      aria-label={label}
      title={label}
    >
      <span className="pw-port-mark" aria-hidden="true">
        {type === 'source' && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            focusable="false"
          >
            <path d="m3.5 2 3 3-3 3" />
          </svg>
        )}
      </span>
    </Handle>
  )
}
