/** 覆盖 EditorWindow 上层派生计算；采样资源与报告仍归画布 hook 持有。 */
import { Profiler, useCallback, useRef, type ReactNode } from 'react'
import {
  EditorPerformanceContext,
  type EditorRenderListener,
} from './editorPerformanceContext'

/** 一次挂载对应一个编辑器／画布；段外回调由 recorder 忽略，不逐帧更新状态。 */
export function EditorPerformanceBoundary({
  children,
}: {
  readonly children: ReactNode
}) {
  const listener = useRef<EditorRenderListener | null>(null)
  const subscribe = useCallback((next: EditorRenderListener) => {
    listener.current = next
    return () => {
      if (listener.current === next) listener.current = null
    }
  }, [])
  const onRender = useCallback(
    (_id: string, _phase: string, actual: number, base: number) => {
      listener.current?.(actual, base)
    },
    [],
  )
  return (
    <EditorPerformanceContext.Provider value={subscribe}>
      <Profiler id="editor" onRender={onRender}>
        {children}
      </Profiler>
    </EditorPerformanceContext.Provider>
  )
}
