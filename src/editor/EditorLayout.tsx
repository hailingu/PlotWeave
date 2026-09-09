/**
 * 编辑器布局装配（EditorView 拆分后的布局层）：标题栏、保存/动作横幅、
 * 三栏主体（左栏大纲/设定集、中区画布、右栏检查器/AI）与顶层浮层。
 * 本组件只做 props 解构与布局，不含状态与业务语义。
 */
import EditorTitlebar from './EditorTitlebar'
import ErrorBanner from './ErrorBanner'
import LeftPanel from './panels/LeftPanel'
import RightPanel from './panels/RightPanel'
import EditorCanvasRegion from './EditorCanvasRegion'
import EditorOverlays from './EditorOverlays'
import type { EditorLayoutProps } from './editorLayoutProps'

/** 编辑器整体布局：顶部工具栏（§3.3）+ 三栏主体（§3.4）+ 浮层。 */
export default function EditorLayout(props: EditorLayoutProps) {
  const { project, doc, panels, persistence, history, view, graph, ai } = props
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
      {persistence.saveError !== null && (
        <ErrorBanner
          message={`自动保存失败：${persistence.saveError}（修改已保留，正在自动重试；可检查磁盘后继续编辑）`}
        />
      )}
      {props.actionError !== null && <ErrorBanner message={props.actionError} />}
      <div className="editor-body">
        <LeftPanel
          open={panels.leftOpen}
          width={panels.leftWidth}
          onResize={panels.setLeftWidth}
          nodes={doc.nodes}
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
        <EditorCanvasRegion {...props} />
        <RightPanel
          open={panels.rightOpen}
          width={panels.rightWidth}
          onResize={panels.setRightWidth}
          tab={panels.rightTab}
          onTabChange={(tab) => {
            panels.setRightTab(tab)
            panels.setRightOpen(true)
          }}
          selectedNode={view.selectedNode}
          attachedShotCount={view.selectedNode ? view.shotCountOf(view.selectedNode.id) : 0}
          settings={doc.settings}
          onOpenSettings={props.onOpenSettings}
          canvasDigest={ai.canvasDigest}
          onValidateAi={ai.validateAiReply}
          onValidateCommands={ai.validateCommands}
          onReadNode={ai.readNode}
          onReadSettings={ai.readSettings}
          onApplyAiBatch={ai.applyAiBatch}
          aiSession={props.aiSession}
          aiSessionError={props.aiSessionError}
          aiSessionRetryable={props.aiSessionRetryable}
          onSaveAiSession={props.onSaveAiSession}
        />
      </div>
      <EditorOverlays {...props} />
    </div>
  )
}
