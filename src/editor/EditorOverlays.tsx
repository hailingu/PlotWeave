/**
 * 编辑器浮层（EditorLayout 的顶层叠加）：右键上下文菜单与剧本导出对话框
 * （docs/ui-design.md §4.3/§3.3）。仅按面板状态挂载，动作全部来自装配层。
 */
import CanvasContextMenu from './CanvasContextMenu'
import ExportDialog from './ExportDialog'
import { buildScriptMarkdown } from './exportScript'
import type { EditorLayoutProps } from './editorLayoutProps'

/** 右键菜单：节点 = 设置/复制/删除；空白 = 五类新增（§4.3）。 */
export default function EditorOverlays(props: EditorLayoutProps) {
  const { project, doc, panels, graph } = props
  return (
    <>
      {panels.ctxMenu && (
        <CanvasContextMenu
          x={panels.ctxMenu.x}
          y={panels.ctxMenu.y}
          nodeId={panels.ctxMenu.nodeId}
          edgeId={panels.ctxMenu.edgeId}
          onToggleSettings={panels.toggleSettings}
          onDuplicate={graph.creation.duplicateNode}
          onDeleteNode={(id) => graph.deleteNodesByIds([id])}
          onDeleteEdge={(id) => graph.deleteEdgesByIds([id])}
          onCreate={graph.creation.createNode}
          onClose={() => panels.setCtxMenu(null)}
        />
      )}
      {/* 剧本导出对话框（§3.3/§3.5）：打开时按当前画布生成 */}
      {panels.exportOpen && (
        <ExportDialog
          projectName={project.name}
          text={buildScriptMarkdown(
            project.name,
            doc.nodes,
            doc.edges,
            doc.settings,
            doc.assetsRef.current,
          )}
          onClose={() => panels.setExportOpen(false)}
        />
      )}
    </>
  )
}
