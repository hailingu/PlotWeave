/**
 * 退出前冲刷屏障（issue #47 历轮评审修复）：窗口关闭时若仍有未落盘的 AI
 * 会话（主文件与恢复副本都写失败、正在按节律重试），阻止关闭并立即冲刷；
 * 冲刷仍失败则保留窗口并给出可见诊断，绝不让唯一内存副本随进程消失。
 * macOS ⌘Q 不经过窗口关闭事件（tao 在 applicationWillTerminate 才通知，
 * 无法拦截），该路径由后台重试与恢复副本尽力兜底。
 */
import { useEffect, useState } from 'react'
import { flushPendingAiSessionSaves, hasPendingAiSessionSaves } from './aiSessionStore'

/** 返回退出被阻止时的诊断文案；null = 无。 */
export function useExitFlush(): string | null {
  const [blocked, setBlocked] = useState<string | null>(null)
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
    let disposed = false
    let unlisten: (() => void) | null = null
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      if (disposed) return
      const appWindow = getCurrentWindow()
      unlisten = await appWindow.onCloseRequested(async (event) => {
        if (!hasPendingAiSessionSaves()) return
        event.preventDefault()
        const failed = await flushPendingAiSessionSaves()
        if (failed.length > 0) {
          setBlocked(
            `有 ${failed.length} 个项目的 AI 会话既未写入权威文件也未能写入恢复副本，已阻止退出：请检查磁盘后重试退出`,
          )
          return
        }
        setBlocked(null)
        await appWindow.destroy()
      })
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
  return blocked
}
