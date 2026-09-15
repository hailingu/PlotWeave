/** 正常关闭/⌘Q/Dock 退出前等待三类未落盘数据——画布防抖脏文档、项目保存
 * 链的失败重试登记（含未落定链上动作）、AI 会话主文件——冲刷落定后才放行；
 * 仍有失败则保留窗口并提示（issue #119 把前两类纳入同一道屏障）。
 * 只在用户退出时对每个登记至多重存一次，不维护恢复副本或定时重试。 */
import { useEffect, useState } from 'react'
import {
  flushPendingAiSessionSaves,
  hasPendingAiSessionSaves,
} from './aiSessionStore'
import {
  flushPendingCanvasSaves,
  hasPendingCanvasSaves,
} from './canvasSaveRegistry'
import {
  flushPendingProjectSaves,
  hasPendingProjectSaves,
} from './projectStore/saveChain'

/** 仍有任一未落盘数据源（画布防抖、项目保存链、AI 会话）。 */
function hasPendingSaves(): boolean {
  return (
    hasPendingCanvasSaves() ||
    hasPendingProjectSaves() ||
    hasPendingAiSessionSaves()
  )
}

/** 退出阻断诊断：按仍失败的数据源给出可读清单。 */
function blockedMessage(
  failedProjects: number,
  failedSessions: number,
): string {
  const parts: string[] = []
  if (failedProjects > 0) parts.push(`${failedProjects} 个项目的画布保存失败`)
  if (failedSessions > 0)
    parts.push(`${failedSessions} 个项目的 AI 会话保存失败`)
  return `有 ${parts.join('、')}，已阻止退出：请检查磁盘后重试退出`
}

/** 返回退出被阻止时的诊断文案；null = 无。 */
export function useExitFlush(): string | null {
  const [blocked, setBlocked] = useState<string | null>(null)
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window))
      return
    let disposed = false
    const unlistens: Array<() => void> = []
    void (async () => {
      const [{ getCurrentWindow }, { listen }, { invoke }] = await Promise.all([
        import('@tauri-apps/api/window'),
        import('@tauri-apps/api/event'),
        import('@tauri-apps/api/core'),
      ])
      if (disposed) return
      const appWindow = getCurrentWindow()
      /** 排空到固定点后执行 onClean；仍有阻断项则不执行并显示诊断。三源
       * 全部成功才重查——冲刷期间的新编辑/新保存进下一轮，静止才放行。 */
      const drainAndThen = async (
        onClean: () => Promise<void>,
      ): Promise<void> => {
        for (;;) {
          // 画布先冲刷：最新编辑先行入链，其失败登记由项目冲刷接管并计失败
          await flushPendingCanvasSaves()
          const failedProjects = await flushPendingProjectSaves()
          const failedSessions = await flushPendingAiSessionSaves()
          if (failedProjects.length > 0 || failedSessions.length > 0) {
            setBlocked(
              blockedMessage(failedProjects.length, failedSessions.length),
            )
            return
          }
          if (!hasPendingSaves()) break
        }
        setBlocked(null)
        await onClean()
      }
      const [unlistenClose, unlistenQuit] = await Promise.all([
        appWindow.onCloseRequested(async (event) => {
          if (!hasPendingSaves()) return
          event.preventDefault()
          await drainAndThen(() => appWindow.destroy())
        }),
        // ⌘Q（Rust 侧菜单接管，lib.rs install_quit_barrier_menu）：同一道
        // 冲刷屏障；无待保存直接受控退出
        listen('app-quit-requested', async () => {
          if (!hasPendingSaves()) {
            await invoke('app_exit')
            return
          }
          await drainAndThen(() => invoke('app_exit'))
        }),
      ])
      unlistens.push(unlistenClose, unlistenQuit)
      // 监听注册完成后确认就绪（issue #65）：后端消费启动间隙（原生屏障
      // 已装、本监听未注册）缓冲的退出请求并重放 app-quit-requested——
      // 确认必须晚于注册，保证重放必有接收者且走同一冲刷屏障
      await invoke('acknowledge_quit_listener')
    })()
    return () => {
      disposed = true
      unlistens.forEach((unlisten) => unlisten())
    }
  }, [])
  return blocked
}
