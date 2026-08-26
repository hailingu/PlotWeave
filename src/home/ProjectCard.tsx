import WeaveCover from './WeaveCover'
import { formatRelativeTime, projectStatsLabel, type ProjectSummary } from './projects'

interface ProjectCardProps {
  project: ProjectSummary
  /** 双击海报打开项目（docs/ui-design.md §3.2）。 */
  onOpen: (id: string) => void
  /** 右键海报或点悬停 ⋯ 按钮弹出项目菜单（§3.2）。 */
  onMenu: (e: { clientX: number; clientY: number; preventDefault: () => void }, project: ProjectSummary) => void
}

/**
 * 项目海报卡：9:16 竖版海报——封面 + 底部渐变压字（剧名 / 统计），
 * 卡下居中展示相对更新时间；无封面时用织线兜底图。
 * 宽度由网格列固定（180–220pt），卡片自身不拉伸。
 * 悬停右上角浮现 ⋯ 菜单按钮，与右键同源（§3.2）。
 */
export default function ProjectCard({ project, onOpen, onMenu }: ProjectCardProps) {
  const posterStyle = project.cover
    ? { background: project.cover }
    : undefined
  return (
    <div className="project-card">
      <button
        type="button"
        className={`project-poster${project.cover ? '' : ' project-poster--weave'}`}
        style={posterStyle}
        onDoubleClick={() => onOpen(project.id)}
        onContextMenu={(e) => onMenu(e, project)}
        aria-label={`打开项目 ${project.name}`}
      >
        {!project.cover && <WeaveCover />}
        <span className="project-poster-caption">
          <span className="project-poster-name">{project.name}</span>
          <span className="project-poster-stats">
            {projectStatsLabel(project)}
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
      <div className="project-card-time">
        {formatRelativeTime(project.updatedAt)}
      </div>
    </div>
  )
}
