/** 正常关闭/⌘Q/Dock 退出前等待四类未落盘数据——画布防抖脏文档、项目保存
 * 链的失败重试登记（含未落定链上动作）、AI 会话主文件、设置及在途密钥——冲刷落定后才放行；
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
import { IPC_COMMANDS } from './ipc/commands'
import { ipcInvoke } from './ipc/invoke'
import { detectHostKind } from './platform/hostEnvironment'
import { listenHostEvent } from './platform/hostEvents'
import {
  flushPendingSettingsSaves,
  hasPendingSettingsSaves,
} from './settings/settingsSaveRegistry'

/** 仍有任一未落盘数据源（画布防抖、项目保存链、AI 会话、设置）。 */
function hasPendingSaves(): boolean {
  return (
    hasPendingCanvasSaves() ||
    hasPendingProjectSaves() ||
    hasPendingAiSessionSaves() ||
    hasPendingSettingsSaves()
  )
}

/** 退出阻断诊断：按仍失败的数据源给出可读清单。 */
function blockedMessage(
  failedProjects: number,
  failedSessions: number,
  failedSettings: number,
): string {
  const parts: string[] = []
  if (failedProjects > 0) parts.push(`${failedProjects} 个项目的画布保存失败`)
  if (failedSessions > 0)
    parts.push(`${failedSessions} 个项目的 AI 会话保存失败`)
  if (failedSettings > 0) parts.push('应用设置保存失败')
  return `有 ${parts.join('、')}，已阻止退出：请检查磁盘后重试退出`
}

/** 四个所有者排空到固定点；冲刷期间的新编辑进入下一轮，不提前授权退出。 */
async function drainBeforeExit(
  onBlocked: (message: string | null) => void,
  onClean: () => Promise<unknown>,
): Promise<void> {
  for (;;) {
    await flushPendingCanvasSaves()
    const projects = await flushPendingProjectSaves()
    const sessions = await flushPendingAiSessionSaves()
    const settings = await flushPendingSettingsSaves()
    if (projects.length > 0 || sessions.length > 0 || settings > 0) {
      onBlocked(blockedMessage(projects.length, sessions.length, settings))
      return
    }
    if (!hasPendingSaves()) break
  }
  onBlocked(null)
  await onClean()
}

/** 返回退出被阻止时的诊断；Swift 的窗口关闭与应用退出共享宿主退出意图。 */
export function useExitFlush(): string | null {
  const [blocked, setBlocked] = useState<string | null>(null)
  useEffect(() => {
    const host = detectHostKind()
    if (host === 'browser') return
    let disposed = false
    let quitting: Promise<void> | null = null
    const unlistens: Array<() => void> = []
    const register = (unlisten: () => void) => {
      if (disposed) unlisten()
      else unlistens.push(unlisten)
    }
    const onBlocked = (message: string | null) => {
      if (!disposed) setBlocked(message)
    }
    const requestExit = async (exit: () => Promise<unknown>, flush = false) => {
      try {
        const onClean = async () => {
          if (!disposed) await exit()
        }
        if (flush || hasPendingSaves())
          await drainBeforeExit(onBlocked, onClean)
        else await onClean()
      } catch (error) {
        onBlocked(
          `退出失败，已保留窗口：${String(error)}。请核对保存状态后重试退出`,
        )
      }
    }
    const onQuit = () => {
      if (disposed || quitting !== null) return
      quitting = requestExit(() => ipcInvoke(IPC_COMMANDS.appExit)).finally(
        () => {
          quitting = null
        },
      )
    }
    void (async () => {
      try {
        if (host === 'tauri') {
          const { getCurrentWindow } = await import('@tauri-apps/api/window')
          if (disposed) return
          const appWindow = getCurrentWindow()
          register(
            await appWindow.onCloseRequested(async (event) => {
              if (!hasPendingSaves()) return
              event.preventDefault()
              await requestExit(() => appWindow.destroy(), true)
            }),
          )
        }
        if (disposed) return
        register(await listenHostEvent('app-quit-requested', onQuit))
        if (disposed) return
        // 先监听后确认：原生侧可在确认请求中立即重放启动间隙的退出意图。
        await ipcInvoke(IPC_COMMANDS.acknowledgeQuitListener)
      } catch (error) {
        // 部分就绪的关闭屏障保留至卸载，初始化失败不能使关闭绕过冲刷。
        onBlocked(
          `退出冲刷初始化失败：${String(error)}。已缓冲的退出请求未丢弃，请重试退出或重启应用`,
        )
      }
    })()
    return () => {
      disposed = true
      unlistens.forEach((unlisten) => unlisten())
    }
  }, [])
  return blocked
}
