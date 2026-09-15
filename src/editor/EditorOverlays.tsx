/**
 * 编辑器浮层（EditorLayout 的顶层叠加）：右键上下文菜单与剧本导出对话框
 * （docs/ui-design.md §4.3/§3.3）。仅按面板状态挂载，动作全部来自装配层。
 * 输入边界（issue #104）：只接收本区域真实消费的四个域，布局层不再透传
 * 整包 EditorLayoutProps——AI 会话、保存回调等无关输入在类型层即不可达。
 */
import CanvasContextMenu from './CanvasContextMenu'
import ExportDialog from './ExportDialog'
import { buildScriptExport } from './exportScript'
import type { EditorGraphActions } from './useEditorGraphActions'
import type { EditorPanels } from './useEditorPanels'
import type { EditorDocument, EditorProjectContent } from './useEditorDocument'

/**
 * 浮层区域的收窄输入（issue #104）：project/doc/panels 按域整体复用现有
 * 域模型；graph 是最宽的动作聚合，仅取右键菜单实际用到的创建/复制与两类
 * 删除。新增浮层消费字段时在此与布局层传参同步登记。
 */
export interface EditorOverlaysProps {
  /** 打开的项目：名称用于导出文件名与脚本导出正文。 */
  readonly project: EditorProjectContent
  /** 会话文档：导出正文读取节点/连线/设定/资产/分集标题。 */
  readonly doc: EditorDocument
  /** 面板状态：右键菜单与导出对话框的挂载开关、坐标与收起。 */
  readonly panels: EditorPanels
  /** 右键菜单动作：节点复制/删除、连线删除与空白处新增。 */
  readonly graph: Pick<
    EditorGraphActions,
    'creation' | 'deleteNodesByIds' | 'deleteEdgesByIds'
  >
}

/** 右键菜单：节点 = 设置/复制/删除；空白 = 五类新增（§4.3）。 */
export default function EditorOverlays(props: EditorOverlaysProps) {
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
      {/* 剧本导出对话框（§3.3/§3.5）：打开时按当前画布生成一次，正文与可选大纲共用 */}
      {panels.exportOpen && (
        <ExportDialog
          projectName={project.name}
          model={buildScriptExport({
            projectName: project.name,
            nodes: doc.nodes,
            edges: doc.edges,
            settings: doc.settings,
            assets: doc.assetsRef.current,
            episodeTitles: doc.episodeTitles,
          })}
          onClose={() => panels.setExportOpen(false)}
        />
      )}
    </>
  )
}
