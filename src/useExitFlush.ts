/**
 * 退出前冲刷屏障（issue #47 历轮评审修复）：窗口关闭时若仍有未落盘的 AI
 * 会话（主文件与恢复副本都写失败、正在按节律重试），阻止关闭并立即冲刷；
 * 冲刷仍失败则保留窗口并给出可见诊断，绝不让唯一内存副本随进程消失。
 * 冲刷与销毁的间隙用户仍可能新增保存：排空到固定点后才销毁窗口。
 * macOS ⌘Q 由 Rust 侧接管应用菜单后经 `app-quit-requested` 事件到达
 * （tao 的原生 terminate 不可拦截）：共用同一道冲刷屏障，排空后走受控
 * app_exit 退出，仍有不可恢复项则不退出。系统级强制终止（kill 等）仍
 * 不可拦截，属既有文档边界。
 */
import { useEffect, useState } from 'react'
import { flushPendingAiSessionSaves, hasPendingAiSessionSaves } from './aiSessionStore'

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
      /** 排空到固定点后执行 onClean；仍有不可恢复项则不执行并显示诊断。 */
      const drainAndThen = async (onClean: () => Promise<void>): Promise<void> => {
        for (;;) {
          const failed = await flushPendingAiSessionSaves()
          if (failed.length > 0) {
            setBlocked(
              `有 ${failed.length} 个项目的 AI 会话既未写入权威文件也未能写入恢复副本，已阻止退出：请检查磁盘后重试退出`,
            )
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
    })()
    return () => {
      disposed = true
      unlistens.forEach((unlisten) => unlisten())
    }
  }, [])
  return blocked
}
