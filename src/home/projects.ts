/**
 * 首页片库的数据模型与纯逻辑。
 * ProjectSummary 是首页海报卡的展示模型；数据未来由 Rust 端
 * `list_projects` 命令从 index.json 提供（docs/ui-design.md §3.2），
 * 本文件在项目持久化落地前提供占位数据，搜索过滤按设计走内存过滤。
 */

/** 项目摘要：首页海报卡的展示模型，统计字段均可从画布节点计数派生。 */
export interface ProjectSummary {
  id: string
  /** 剧名。 */
  name: string
  /** 场次数（场景节点计数）。 */
  sceneCount: number
  /** 结局数；大于 1 时在海报上展示「双结局 / n 结局」。 */
  endingCount?: number
  /**
   * 封面：CSS 渐变或图片 URL，取自用户从项目资产中选定的封面；
   * 缺省时首页用「织线」mini-map 兜底（呼应 PlotWeave 之名）。
   */
  cover?: string
  /** 最近更新时间（ISO 8601）。 */
  updatedAt: string
}

/** 海报底部统计文案：「24 场 · 双结局」。 */
export function projectStatsLabel(project: ProjectSummary): string {
  const endings = project.endingCount ?? 0
  const suffix =
    endings === 2 ? ' · 双结局' : endings > 2 ? ` · ${endings} 结局` : ''
  return `${project.sceneCount} 场${suffix}`
}

/** 按剧名做内存过滤；空白查询返回全部。 */
export function filterProjects(
  projects: ProjectSummary[],
  query: string,
): ProjectSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return projects
  return projects.filter((p) => p.name.toLowerCase().includes(q))
}

/** 相对更新时间：刚刚 / n 分钟前 / n 小时前 / 昨天 / n 天前 / M 月 D 日。 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  const diffMs = now.getTime() - then.getTime()
  if (Number.isNaN(diffMs) || diffMs < 0) return ''
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return `${then.getMonth() + 1} 月 ${then.getDate()} 日`
}

/**
 * 占位项目数据：让首页在持久化命令（list_projects）落地前即可预览
 * 真实排版——一张带封面、一张走织线兜底。接入后端后删除。
 */
export function createSampleProjects(now: Date = new Date()): ProjectSummary[] {
  const hoursAgo = (h: number) =>
    new Date(now.getTime() - h * 3_600_000).toISOString()
  return [
    {
      id: 'sample-du-shi-qi-yuan',
      name: '都市奇缘',
      sceneCount: 24,
      endingCount: 2,
      cover: 'linear-gradient(160deg, #2b2f4c, #e0176e)',
      updatedAt: hoursAgo(2),
    },
    {
      id: 'sample-wu-ye-chu-zu-che',
      name: '午夜出租车',
      sceneCount: 18,
      updatedAt: hoursAgo(26),
    },
  ]
}
