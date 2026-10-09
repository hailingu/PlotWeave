/** 单个编辑器边界只连接其当前画布采样 owner，不共享跨项目全局统计。 */
import { createContext } from 'react'

/** 整体渲染与画布渲染使用同一 React 计时语义，但保持独立汇总。 */
export type EditorRenderListener = (actual: number, base: number) => void

/** 注册器返回身份约束的清理函数，防止旧挂载清理新 listener。 */
export const EditorPerformanceContext = createContext<
  ((listener: EditorRenderListener) => () => void) | null
>(null)
