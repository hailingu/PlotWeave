import type { ProjectSummary } from './projects'

/** 最近一次打开失败的可见反馈（issue #98）：App 层在加载拒绝时写入，
 * 首页以非阻塞横幅展示可读原因；id 供横幅按项目列表解析名称。 */
export interface OpenProjectError {
  /** 打开失败的项目 id。 */
  readonly id: string
  /** 可读失败原因（版本过新/损坏/IO 等，已去 Error 前缀）。 */
  readonly detail: string
}

/** 横幅文案：列表可解析出项目名则点名失败项目，否则用通用说法——
 * 损坏文件可能在列表阶段被跳过而未进列表，不能假设 id 一定可解析。 */
function openErrorText(
  error: OpenProjectError,
  projects: readonly ProjectSummary[],
): string {
  const name = projects.find((p) => p.id === error.id)?.name
  return name
    ? `打开「${name}」失败：${error.detail}`
    : `打开项目失败：${error.detail}`
}

/** 打开失败警示横幅（issue #98；自 HomePage 拆出以守祖父化组件行数，
 * PR #110 评审）：role=alert 即时播报；非阻塞，停留至下一次打开尝试
 * 或新建成功，不拦截首页任何操作（docs/ui-design.md §3.2）。 */
export function OpenErrorBanner({
  error,
  projects,
}: {
  readonly error: OpenProjectError
  readonly projects: readonly ProjectSummary[]
}) {
  return (
    <div className="home-open-error" role="alert">
      {openErrorText(error, projects)}
    </div>
  )
}
