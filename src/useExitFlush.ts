/** 正常关闭/⌘Q/Dock 退出前等待 AI 会话主文件保存；失败保留窗口并提示。
 * 只在用户退出时尝试一次失败快照，不维护恢复副本或定时重试。 */
import { useEffect, useState } from 'react'
import {
  flushPendingAiSessionSaves,
  hasPendingAiSessionSaves,
} from './aiSessionStore'

/** 返回退出被阻止时的诊断文案；null = 无。 */
export function useExitFlush(): string | null {
  const [blocked, setBlocked] = useState<string | null>(null)
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
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
      /** 排空到固定点后执行 onClean；仍有阻断项则不执行并显示诊断。 */
      const drainAndThen = async (onClean: () => Promise<void>): Promise<void> => {
        for (;;) {
          const failed = await flushPendingAiSessionSaves()
          if (failed.length > 0) {
            setBlocked(`有 ${failed.length} 个项目的 AI 会话保存失败，已阻止退出：请检查磁盘后重试退出`)
            return
          }
          if (!hasPendingAiSessionSaves()) break
        }
        setBlocked(null)
        await onClean()
      }
      const [unlistenClose, unlistenQuit] = await Promise.all([
        appWindow.onCloseRequested(async (event) => {
          if (!hasPendingAiSessionSaves()) return
          event.preventDefault()
          await drainAndThen(() => appWindow.destroy())
        }),
        // ⌘Q（Rust 侧菜单接管，lib.rs install_quit_barrier_menu）：同一道
        // 冲刷屏障；无待保存直接受控退出
        listen('app-quit-requested', async () => {
          if (!hasPendingAiSessionSaves()) {
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
