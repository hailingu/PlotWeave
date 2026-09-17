import type { ProjectSummary } from './projects'

/** 首页项目变更失败（issue #132）：动作 + 目标 + 可读诊断，供横幅呈现。
 * 目标归属：delete/duplicate 携 targetId（横幅经当前列表解析名称），
 * create/rename 携 targetName（尝试写入的名称——rename 目标项目可能已
 * 不在列表，新名称才是用户刚输入的操作对象）。 */
export interface HomeActionFailure {
  readonly action: 'create' | 'rename' | 'duplicate' | 'delete'
  readonly targetId?: string
  readonly targetName?: string
  readonly detail: string
}

/** 动作名（中文动作词，与卡片菜单/工具栏文案一致）。 */
const ACTION_LABEL: Record<HomeActionFailure['action'], string> = {
  create: '创建项目',
  rename: '重命名',
  duplicate: '复制',
  delete: '删除',
}

/** 横幅文案：「删除「雨夜」失败：{诊断}」；id 无列表名时回退 id，
 * 不得因解析不到名称而丢掉目标归属。 */
function actionErrorText(
  error: HomeActionFailure,
  projects: readonly ProjectSummary[],
): string {
  const target =
    error.targetName ??
    projects.find((p) => p.id === error.targetId)?.name ??
    error.targetId ??
    ''
  return `${ACTION_LABEL[error.action]}「${target}」失败：${error.detail}`
}

/** 首页项目变更失败横幅（issue #132）：role=alert 即时播报，非阻塞——
 * 首页操作能力保留；重试以同参重发失败的动作（App 层持有重试闭包），
 * 横幅停留至下一次变更尝试或重试成功（新尝试即视为旧错误过时）。 */
export function ActionErrorBanner({
  error,
  projects,
  onRetry,
}: {
  readonly error: HomeActionFailure
  readonly projects: readonly ProjectSummary[]
  readonly onRetry: () => void
}) {
  return (
    <div className="home-open-error" role="alert">
      {actionErrorText(error, projects)}
      <button type="button" className="home-retry" onClick={onRetry}>
        重试
      </button>
    </div>
  )
}
