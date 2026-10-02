/**
 * 编辑器布局装配（EditorView 拆分后的布局层）：标题栏、保存/动作横幅、
 * 三栏主体（左栏大纲/设定集、中区画布、右栏检查器/AI）与顶层浮层。
 * 本组件只做 props 解构与布局，不含状态与业务语义。
 */
import { useMemo } from 'react'
import { EditorTitlebar } from './EditorTitlebar'
import { ErrorBanner } from './ErrorBanner'
import { LeftPanel } from './panels/LeftPanel'
import { RightPanel, type RightPanelAiProps } from './panels/RightPanel'
import {
  EditorCanvasRegion,
  type EditorCanvasRegionProps,
} from './EditorCanvasRegion'
import { EditorOverlays, type EditorOverlaysProps } from './EditorOverlays'
import type { EditorLayoutProps } from './editorLayoutProps'

/** 布局横幅区（EditorLayout 拆分，issue #99）：自动保存失败与动作错误。 */
function LayoutBanners({
  saveError,
  actionError,
}: {
  readonly saveError: string | null
  readonly actionError: string | null
}) {
  return (
    <>
      {saveError !== null && (
        <ErrorBanner
          message={`自动保存失败：${saveError}（修改已保留，正在自动重试；可检查磁盘后继续编辑）`}
        />
      )}
      {actionError !== null && <ErrorBanner message={actionError} />}
    </>
  )
}

/** 右栏切页（EditorLayout 拆分）：切页即展开右栏。 */
function switchRightTab(
  panels: EditorLayoutProps['panels'],
  tab: EditorLayoutProps['panels']['rightTab'],
): void {
  panels.setRightTab(tab)
  panels.setRightOpen(true)
}

/** 画布区域输入挑选（issue #103 渲染隔离）：从整包布局 props 中只挑
 * EditorCanvasRegion 真实消费的字段——面板状态变化时这些成员引用稳定，
 * memo 边界即可跳过画布子树执行。画布新增消费字段时在此同步登记。 */
function toCanvasRegionProps(
  props: EditorLayoutProps,
): EditorCanvasRegionProps {
  return {
    project: props.project,
    canvasRef: props.canvasRef,
    doc: props.doc,
    displayNodes: props.view.displayNodes,
    onCanvasDragOver: props.graph.drop.onCanvasDragOver,
    onCanvasDrop: props.graph.drop.onCanvasDrop,
    isValidConnection: props.graph.connection.isValidConnection,
    onConnect: props.graph.connection.onConnect,
    onNodeDragStart: props.graph.drag.onNodeDragStart,
    onNodeDragStop: props.graph.drag.onNodeDragStop,
    onNodeContextMenu: props.graph.menu.onNodeContextMenu,
    onEdgeContextMenu: props.graph.menu.onEdgeContextMenu,
    onPaneContextMenu: props.graph.menu.onPaneContextMenu,
    onAutoLayout: props.graph.layout.onAutoLayout,
    onAlignNodes: props.graph.alignment.onAlignNodes,
    onMoveEnd: props.persistence.onMoveEnd,
  }
}

/** 浮层区域输入挑选（issue #104）：只下传 EditorOverlays 真实消费的四个域
 * （收窄契约见 EditorOverlaysProps），AI 会话、保存回调等其余输入在类型层
 * 即不可达；新增浮层消费字段时在此与该接口同步登记。组件外的挑选函数同时
 * 保证布局组件自身不超过 80 行上限。 */
function toOverlaysProps(props: EditorLayoutProps): EditorOverlaysProps {
  return {
    project: props.project,
    doc: props.doc,
    panels: props.panels,
    graph: props.graph,
  }
}

/** LeftPanel 的文档弹窗域（issue #126 状态提升）：面板域持有挂载开关与
 * 开关动作，快捷键层据此挂起全局撤销/重做（组件外挑选保持行数上限）。 */
function toDocDialogProps(panels: EditorLayoutProps['panels']) {
  return {
    docDialog: {
      editingDocId: panels.editingDocId,
      open: panels.openDocument,
      close: panels.closeDocument,
    },
  }
}

/** 右栏 ✦AI 能力域聚合（issue #401）：把布局 props 中服务 AI 分段的
 * 字段（ai 桥回调、提交身份、会话快照与保存通道、设置入口）捆成
 * `RightPanel` 的单一 `ai` prop。useMemo 键为 ai 桥的逐成员引用（桥
 * 对象本身逐渲染重建）：成员稳定 ⇒ 聚合引用稳定，不扩大重渲染范围
 * （AiThread 的 memo 边界逐成员比较，issue #157；捆绑先例见
 * EditorView 的 commitIdentity）。 */
function useRightAi(props: EditorLayoutProps): RightPanelAiProps {
  return useMemo(
    () => ({
      projectId: props.project.id,
      onOpenSettings: props.onOpenSettings,
      canvasDigest: props.ai.canvasDigest,
      commitIdentity: props.commitIdentity,
      onValidateAi: props.ai.validateAiReply,
      onValidateCommands: props.ai.validateCommands,
      onReadNode: props.ai.readNode,
      onFindNodes: props.ai.findNodes,
      onReadSettings: props.ai.readSettings,
      onReadDocument: props.ai.readDocument,
      onApplyAiBatch: props.ai.applyAiBatch,
      session: props.aiSession,
      sessionError: props.aiSessionError,
      sessionRetryable: props.aiSessionRetryable,
      sessionLoadFailed: props.aiSessionLoadFailed,
      onSaveSession: props.onSaveAiSession,
    }),
    [
      props.project.id,
      props.onOpenSettings,
      props.ai.canvasDigest,
      props.commitIdentity,
      props.ai.validateAiReply,
      props.ai.validateCommands,
      props.ai.readNode,
      props.ai.findNodes,
      props.ai.readSettings,
      props.ai.readDocument,
      props.ai.applyAiBatch,
      props.aiSession,
      props.aiSessionError,
      props.aiSessionRetryable,
      props.aiSessionLoadFailed,
      props.onSaveAiSession,
    ],
  )
}

/** 编辑器整体布局：顶部工具栏（§3.3）+ 三栏主体（§3.4）+ 浮层。 */
export function EditorLayout(props: EditorLayoutProps) {
  const { project, doc, panels, persistence, history, view, graph } = props
  const rightAi = useRightAi(props)
  return (
    <div className="editor-root">
      {/* Overlay 标题栏下整行作为窗口拖拽区；按钮可点击（§3.3）。 */}
      <EditorTitlebar
        projectName={project.name}
        onRenameProject={props.onRenameProject}
        leftOpen={panels.leftOpen}
        onToggleLeft={() => panels.setLeftOpen((v) => !v)}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        onUndo={history.undo}
        onRedo={history.onRedo}
        onBackHome={props.onBackHome}
        plusOpen={panels.plusOpen}
        onTogglePlus={() => panels.setPlusOpen((v) => !v)}
        onCreateNode={graph.creation.createNode}
        onOpenExport={() => panels.setExportOpen(true)}
        inspectorOn={panels.rightOpen && panels.rightTab === 'inspector'}
        aiOn={panels.rightTab === 'ai' && panels.rightOpen}
        onToggleRight={panels.toggleRight}
      />
      <LayoutBanners
        saveError={persistence.saveError}
        actionError={props.actionError}
      />
      <div className="editor-body">
        <LeftPanel
          {...toDocDialogProps(panels)}
          open={panels.leftOpen}
          width={panels.leftWidth}
          onResize={panels.setLeftWidth}
          nodes={doc.nodes}
          contentNodes={doc.contentNodes}
          edges={doc.edges}
          onLocate={view.locateNode}
          selectedId={view.selectedNode?.id}
          settings={doc.settings}
          settingsActions={graph.settingsActions}
          episodeTitles={doc.episodeTitles}
          focusedEpisode={doc.focusedEpisode}
          onFocusEpisode={graph.episodes.toggleEpisodeFocus}
          onRenameEpisode={graph.episodes.renameEpisode}
          onOutlineDrop={graph.outlineDrop}
        />
        <EditorCanvasRegion {...toCanvasRegionProps(props)} />
        <RightPanel
          open={panels.rightOpen}
          width={panels.rightWidth}
          onResize={panels.setRightWidth}
          tab={panels.rightTab}
          onTabChange={(tab) => switchRightTab(panels, tab)}
          selectedNode={view.selectedNode}
          attachedShotCount={
            view.selectedNode ? view.shotCountOf(view.selectedNode.id) : 0
          }
          settings={doc.settings}
          ai={rightAi}
        />
      </div>
      <EditorOverlays {...toOverlaysProps(props)} />
    </div>
  )
}
