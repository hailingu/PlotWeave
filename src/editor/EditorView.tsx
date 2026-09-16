/**
 * 剧本画布编辑器：顶部统一工具栏（§3.3 左 = 边栏开关 + 返回首页，
 * 中 = 项目名，右 = ＋节点 / 检查器 / ✦AI），下方为三栏布局（§3.4）。
 * 本组件只负责挂 ReactFlowProvider（供内部 useReactFlow 计算创建位置）；
 * EditorWindow 是装配层——状态与动作按域拆至邻近 hook（文档状态
 * useEditorDocument、面板状态 useEditorPanels、落盘 useEditorPersistence、
 * 画布写动作 useEditorGraphActions、AI 桥 useAiBridge 等），布局见
 * EditorLayout 及其区域子组件。
 */
import { useMemo } from 'react'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ImageGenProvider } from './imagegen/ImageGenProvider'
import { NodeEditContext } from './nodeEdit'
import { EditorLayout } from './EditorLayout'
import { useEditorController } from './useEditorController'
import type { EditorProjectContent } from './useEditorDocument'
import type { ProjectContent } from '../model/content'
import type { AiCommitIdentity } from './ai/commitIdentity'
import type { AiSession } from './ai/session'

interface EditorViewProps {
  /** 打开的项目：id 用于持久化，doc 为已加载的会话文档（含名称/画布/设定集/集标题/视口）。 */
  readonly project: EditorProjectContent
  /** 返回项目首页：同一窗口从编辑器状态切回文档浏览器（§3.1）。 */
  readonly onBackHome: () => void
  /** 项目名内联重命名（§3.3 中区：更新 project.name + 首页索引）。 */
  readonly onRenameProject: (name: string) => void
  /** 打开设置页（§8.2 BYOK 配置入口，⌘,）。 */
  readonly onOpenSettings?: () => void
  /** 持久化写入（防抖节流由本组件负责；浏览器预览下为内存回退实现）。
   * 返回 Promise 时失败会上浮：重置脏标记自动重试并横幅提示。 */
  readonly onSave: (doc: ProjectContent) => void | Promise<void>
  /** 独立的项目 AI 会话，不能混入画布文档保存。 */
  readonly aiSession?: AiSession
  /** 会话读取失败的可见诊断；画布仍可正常打开。 */
  readonly aiSessionError?: string | null
  /** 会话读取失败时阻止 AI 发送和执行，画布仍可使用。 */
  readonly aiSessionLoadFailed?: boolean
  /** 内存会话可否作为挂载重试的落盘内容；读取失败（空回退）时为 false。 */
  readonly aiSessionRetryable?: boolean
  readonly onSaveAiSession?: (session: AiSession) => Promise<void>
}

/** Provider 薄壳：把 ReactFlow 上下文交给内部装配层。 */
export function EditorView(props: EditorViewProps) {
  return (
    <ReactFlowProvider>
      <EditorWindow {...props} />
    </ReactFlowProvider>
  )
}

/** 会话缺省值提为模块常量（issue #157）：缺省参数每渲染重建引用，会
 * 击穿 AiThread 的 memo 边界——未传会话 props 的直接消费者（含测试）
 * 在位置帧间拿到稳定引用。 */
const DEFAULT_AI_SESSION: NonNullable<EditorViewProps['aiSession']> = {
  schemaVersion: 1,
  entries: [],
}
const DEFAULT_ON_SAVE_AI_SESSION: NonNullable<
  EditorViewProps['onSaveAiSession']
> = async () => undefined

/** 编辑器装配层：组装各域 hook 与 Provider，渲染布局（不含业务语义）。 */
function EditorWindow({
  project,
  onBackHome,
  onRenameProject,
  onOpenSettings,
  onSave,
  aiSession = DEFAULT_AI_SESSION,
  aiSessionError = null,
  aiSessionRetryable = true,
  aiSessionLoadFailed = false,
  onSaveAiSession = DEFAULT_ON_SAVE_AI_SESSION,
}: EditorViewProps) {
  const { screenToFlowPosition, fitView } = useReactFlow()
  const {
    canvasRef,
    doc,
    panels,
    persistence,
    history,
    view,
    graph,
    ai,
    actionError,
    nodeEditApi,
    imageGen,
  } = useEditorController({ project, onSave, screenToFlowPosition, fitView })
  // AI 执行卡的提交身份捆绑（issue #139）：把 doc.aiRevision 与
  // persistence.whenCanvasCommitted 收成单一嵌套对象下传——类型层保证
  // 等画布落盘的执行卡必带批次计数（缺身份的未确认卡落盘后无法与画布
  // 对账，重开可能重复应用已落盘批次）。useMemo 稳定引用：位置帧重渲染
  // 不得击穿 AiThread 的 memo 边界（issue #157）。
  const commitIdentity = useMemo<AiCommitIdentity>(
    () => ({
      aiRevision: doc.aiRevision,
      whenCanvasCommitted: persistence.whenCanvasCommitted,
    }),
    [doc.aiRevision, persistence.whenCanvasCommitted],
  )
  return (
    <NodeEditContext.Provider value={nodeEditApi}>
      <ImageGenProvider {...imageGen}>
        <EditorLayout
          project={project}
          onBackHome={onBackHome}
          onRenameProject={onRenameProject}
          onOpenSettings={onOpenSettings}
          canvasRef={canvasRef}
          doc={doc}
          commitIdentity={commitIdentity}
          panels={panels}
          persistence={persistence}
          history={history}
          view={view}
          graph={graph}
          ai={ai}
          actionError={actionError}
          aiSession={aiSession}
          aiSessionError={aiSessionError}
          aiSessionRetryable={aiSessionRetryable}
          aiSessionLoadFailed={aiSessionLoadFailed}
          onSaveAiSession={onSaveAiSession}
        />
      </ImageGenProvider>
    </NodeEditContext.Provider>
  )
}
