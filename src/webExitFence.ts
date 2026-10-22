/**
 * 页面退出的业务入场与最终写入闸。操作 future 包含结果交付，不以 IPC 回执代替。
 * 本页协调器独占操作集合及退出租约：完成即移除 future，失败／卸载释放租约，
 * 成功封口保留到页面销毁。没有文档副本，真实新页重新初始化；不跨页重放。
 */
const operations = new Set<Promise<unknown>>()
let active: WebExitFence | null = null

/** 可读且稳定的退出入场拒绝；既有工作在 draining 阶段仍可写回结果。 */
export const WEB_EXIT_PENDING =
  'PW_WEB_EXIT_PENDING：正在保存并退出，请等待；退出失败后可以继续编辑。'

/** 页级退出租约；只有持有者能封口或恢复输入，旧清理不会释放新租约。 */
export interface WebExitFence {
  readonly sealed: boolean
  wait: () => Promise<void>
  seal: () => void
  release: () => void
  report: () => void
}

/** 当前页面已暂停新业务意图；供 Web UI 与原生意图的统一入场判定。 */
export function isWebExitPending(): boolean {
  return active !== null
}

/** 在最终同步封口后拒绝持久化状态写入；冲刷期间允许既有业务交付。 */
export function assertWebWriteAllowed(): void {
  if (active?.sealed) throw new Error(WEB_EXIT_PENDING)
}

/** 用户仍调用新操作时向当前退出 owner 发布诊断，不创建另一份错误状态。 */
export function reportWebExitPending(): void {
  active?.report()
}

/** 所有业务及 React owner 的提交确认都已落定；最终封口同时检查此探针。 */
export function hasPendingWebOperations(): boolean {
  return operations.size > 0
}

/** 已接纳状态写入登记到对应 React 提交；调用方的 effect 或卸载显式完成。 */
export function registerWebStateCommit(): () => void {
  assertWebWriteAllowed()
  let finish!: () => void
  const commit = new Promise<void>((resolve) => {
    finish = resolve
  })
  operations.add(commit)
  return () => {
    operations.delete(commit)
    finish()
  }
}

/** 登记整个业务 future，入场先于执行；所有完成路径释放，原错误继续上浮。 */
export function runWebOperation<T>(action: () => Promise<T>): Promise<T> {
  if (active) return Promise.reject(new Error(WEB_EXIT_PENDING))
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const result = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  operations.add(result)
  const release = () => {
    operations.delete(result)
  }
  void result.then(release, release)
  const complete = async () => {
    try {
      resolve(await action())
    } catch (error) {
      reject(error)
    }
  }
  void complete()
  return result
}

/** 页面同步暂停输入并进入 draining；四源固定点的调用者最后显式 seal。 */
export function beginWebExitFence(report: () => void): WebExitFence {
  if (active) throw new Error(WEB_EXIT_PENDING)
  const root = document.getElementById('root') ?? document.body
  const wasInert = root.inert
  root.inert = true
  const stop = (event: Event) => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const events = ['keydown', 'beforeinput', 'pointerdown', 'click', 'drop']
  events.forEach((event) => document.addEventListener(event, stop, true))
  let sealed = false
  const fence: WebExitFence = {
    get sealed() {
      return sealed
    },
    wait: async () => {
      while (operations.size > 0) await Promise.allSettled(operations)
    },
    seal: () => {
      if (active === fence) sealed = true
    },
    release: () => {
      if (active !== fence) return
      active = null
      root.inert = wasInert
      events.forEach((event) => document.removeEventListener(event, stop, true))
    },
    report,
  }
  active = fence
  return fence
}
