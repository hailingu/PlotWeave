/**
 * 编辑器浮层（EditorLayout 的顶层叠加）：右键上下文菜单与剧本导出对话框
 * （docs/ui-design.md §4.3/§3.3）。仅按面板状态挂载，动作全部来自装配层。
 * 输入边界（issue #104）：只接收本区域真实消费的四个域，布局层不再透传
 * 整包 EditorLayoutProps——AI 会话、保存回调等无关输入在类型层即不可达。
 */
import { useMemo } from 'react'
import { CanvasContextMenu } from './CanvasContextMenu'
import { ExportDialog } from './ExportDialog'
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
export function EditorOverlays(props: EditorOverlaysProps) {
  const { project, doc, panels, graph } = props
  // 剧本导出模型按内容依赖缓存（issue #158，语义收口为「实时预览」）：
  // 打开期间无关渲染复用同一模型——预览/复制/下载本就共读一份；
  // 节点/连线/设定/资产/集标题/项目名任一变化才重建，内容不冻结。
  // 资产取响应式 doc.assets 而非 assetsRef 镜像：ref 读取不进依赖，
  // 模型变化不会触发重建
  const exportModel = useMemo(
    () =>
      panels.exportOpen
        ? buildScriptExport({
            projectName: project.name,
            nodes: doc.nodes,
            edges: doc.edges,
            settings: doc.settings,
            assets: doc.assets,
            episodeTitles: doc.episodeTitles,
          })
        : null,
    [
      panels.exportOpen,
      project.name,
      doc.nodes,
      doc.edges,
      doc.settings,
      doc.assets,
      doc.episodeTitles,
    ],
  )
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
      {/* 剧本导出对话框（§3.3/§3.5）：正文与可选大纲共用缓存模型 */}
      {panels.exportOpen && exportModel !== null && (
        <ExportDialog
          projectName={project.name}
          model={exportModel}
          onClose={() => panels.setExportOpen(false)}
        />
      )}
    </>
  )
}
