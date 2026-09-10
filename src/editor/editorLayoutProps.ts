/**
 * 编辑器装配层与布局层的共享契约：EditorWindow 组装各域 hook 后按域分组
 * 下传，EditorLayout 与区域子组件各自解构所需字段。独立成模块，避免
 * EditorLayout 与区域子组件之间形成类型循环依赖。
 */
import type { RefObject } from 'react'
import type { useCommandHistory } from './history'
import type { AiBridge } from './useAiBridge'
import type { CanvasView } from './useCanvasView'
import type { EditorDocument, EditorProjectContent } from './useEditorDocument'
import type { EditorGraphActions } from './useEditorGraphActions'
import type { EditorPanels } from './useEditorPanels'
import type { EditorPersistence } from './useEditorPersistence'
import type { AiSession } from './ai/session'

/** 命令栈 hook 的返回值（撤销/重做可用态与入口）。 */
export type CommandHistory = ReturnType<typeof useCommandHistory>

/** EditorLayout 及其区域子组件的完整输入，由 EditorWindow 一次装配下传。 */
export interface EditorLayoutProps {
  /** 打开的项目：名称用于标题栏与导出文件名，视口决定首开 fitView。 */
  readonly project: EditorProjectContent
  readonly onBackHome: () => void
  readonly onRenameProject: (name: string) => void
  readonly onOpenSettings?: () => void
  /** 画布容器：新节点落点中心换算与拖放命中读它。 */
  readonly canvasRef: RefObject<HTMLDivElement>
  readonly doc: EditorDocument
  readonly panels: EditorPanels
  readonly persistence: EditorPersistence
  readonly history: CommandHistory
  readonly view: CanvasView
  readonly graph: EditorGraphActions
  readonly ai: AiBridge
  /** 拖放导入失败等瞬态动作诊断；null = 无。 */
  readonly actionError: string | null
  /** 独立于画布文档的项目 AI 会话。 */
  readonly aiSession: AiSession
  readonly aiSessionError: string | null
  /** 会话读取失败时阻止 AI 发送和执行，画布仍可使用。 */
  readonly aiSessionLoadFailed?: boolean
  /** 内存会话可否作为挂载重试的落盘内容；读取失败（空回退）时为 false。 */
  readonly aiSessionRetryable: boolean
  readonly onSaveAiSession: (session: AiSession) => Promise<void>
}
