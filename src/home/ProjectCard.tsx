import { WeaveCover } from './WeaveCover'
import {
  formatRelativeTime,
  projectStatsLabel,
  type ProjectSummary,
} from './projects'

interface ProjectCardProps {
  readonly project: ProjectSummary
  /** 单击海报打开项目（docs/ui-design.md §3.2；应用方修订：由双击改单击）。 */
  readonly onOpen: (id: string) => void
  /** 右键海报或点悬停 ⋯ 按钮弹出项目菜单（§3.2）。 */
  readonly onMenu: (
    e: { clientX: number; clientY: number; preventDefault: () => void },
    project: ProjectSummary,
  ) => void
}

/**
 * 项目海报卡：9:16 竖版海报——封面 + 底部渐变压字（剧名 / 统计），
 * 卡下居中展示相对更新时间；无封面时用织线兜底图。
 * 宽度由网格列固定（180–220pt），卡片自身不拉伸。
 * 悬停右上角浮现 ⋯ 菜单按钮，与右键同源（§3.2）。
 * 损坏占位变体（issue #123）：文件存在但不可读/不可解析——占位名 +
 * 诊断替代统计行，无封面无时间；点击仍走打开入口，load_project 的
 * 失败横幅（issue #98）呈现完整诊断；菜单保留（删除可清理坏文件）。
 */
/** 海报类名派生：损坏占位（issue #123）> 显式封面 > 织线兜底。 */
function posterClass(project: ProjectSummary): string {
  if (project.error !== undefined)
    return 'project-poster project-poster--broken'
  return `project-poster${project.cover ? '' : ' project-poster--weave'}`
}

export function ProjectCard({ project, onOpen, onMenu }: ProjectCardProps) {
  const broken = project.error !== undefined
  const posterStyle =
    !broken && project.cover ? { background: project.cover } : undefined
  return (
    <div className="project-card">
      <button
        type="button"
        className={posterClass(project)}
        style={posterStyle}
        onClick={() => onOpen(project.id)}
        onContextMenu={(e) => onMenu(e, project)}
        aria-label={
          broken ? `项目损坏 ${project.name}` : `打开项目 ${project.name}`
        }
      >
        {!broken && !project.cover && <WeaveCover />}
        <span className="project-poster-caption">
          <span className="project-poster-name">{project.name}</span>
          <span className="project-poster-stats">
            {broken ? project.error : projectStatsLabel(project)}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="project-menu-btn"
        aria-label={`项目菜单 ${project.name}`}
        onClick={(e) => onMenu(e, project)}
      >
        ⋯
      </button>
      {!broken && (
        <div className="project-card-time">
          {formatRelativeTime(project.updatedAt)}
        </div>
      )}
    </div>
  )
}
