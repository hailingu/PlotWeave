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
import { detectHostKind, type HostKind } from './platform/hostEnvironment'
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
): Promise<boolean> {
  for (;;) {
    await flushPendingCanvasSaves()
    const projects = await flushPendingProjectSaves()
    const sessions = await flushPendingAiSessionSaves()
    const settings = await flushPendingSettingsSaves()
    if (projects.length > 0 || sessions.length > 0 || settings > 0) {
      onBlocked(blockedMessage(projects.length, sessions.length, settings))
      return false
    }
    if (!hasPendingSaves()) break
  }
  onBlocked(null)
  await onClean()
  return true
}

/** 一页独占退出冲刷、失败回执与监听资源，销毁后不再批准任何退出。 */
type ExitBarrier = {
  disposed: () => boolean
  register: (unlisten: () => void) => void
  request: (exit: () => Promise<unknown>, flush?: boolean) => Promise<void>
  onQuit: () => void
  initializationFailed: (error: unknown) => Promise<void>
  dispose: () => void
}

/** 保存协调与系统退出回执的生命周期；Swift 失败显式取消，Tauri 保持原有屏障。 */
function createExitBarrier(
  host: HostKind,
  onBlocked: (message: string | null) => void,
): ExitBarrier {
  let disposed = false
  let quitting: Promise<void> | null = null
  let diagnostic: string | null = null
  const unlistens: Array<() => void> = []
  const report = (message: string | null) => {
    diagnostic = message
    if (!disposed) onBlocked(message)
  }
  const cancelExit = async () => {
    if (host !== 'swift' || disposed) return
    try {
      await ipcInvoke(IPC_COMMANDS.appExit, { cancel: true })
    } catch (error) {
      report(
        `${diagnostic ?? '退出未完成'}；取消系统退出失败：${String(error)}`,
      )
    }
  }
  const request = async (exit: () => Promise<unknown>, flush = false) => {
    let clean = false
    try {
      const onClean = async () => {
        if (!disposed) await exit()
      }
      if (flush || hasPendingSaves())
        clean = await drainBeforeExit(report, onClean)
      else {
        await onClean()
        clean = true
      }
    } catch (error) {
      report(`退出失败，已保留窗口：${String(error)}。请核对保存状态后重试退出`)
    } finally {
      if (!clean) await cancelExit()
    }
  }
  return {
    disposed: () => disposed,
    register: (unlisten) => {
      if (disposed) unlisten()
      else unlistens.push(unlisten)
    },
    request,
    onQuit: () => {
      if (disposed || quitting !== null) return
      quitting = request(() => ipcInvoke(IPC_COMMANDS.appExit)).finally(() => {
        quitting = null
      })
    },
    initializationFailed: async (error) => {
      const recovery =
        host === 'swift'
          ? '请修复后重试退出'
          : '已缓冲的退出请求未丢弃，请重试退出或重启应用'
      report(`退出冲刷初始化失败：${String(error)}。${recovery}`)
      await cancelExit()
    },
    dispose: () => {
      disposed = true
      unlistens.forEach((unlisten) => unlisten())
    },
  }
}

/** 先建立页面监听再确认就绪；部分完成资源保留至卸载，失败经同一回执通道落定。 */
async function installExitListeners(
  host: HostKind,
  barrier: ExitBarrier,
): Promise<void> {
  try {
    if (host === 'tauri') {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      if (barrier.disposed()) return
      const appWindow = getCurrentWindow()
      barrier.register(
        await appWindow.onCloseRequested(async (event) => {
          if (!hasPendingSaves()) return
          event.preventDefault()
          await barrier.request(() => appWindow.destroy(), true)
        }),
      )
    }
    if (barrier.disposed()) return
    barrier.register(
      await listenHostEvent('app-quit-requested', barrier.onQuit),
    )
    if (barrier.disposed()) return
    // 先监听后确认：原生侧可在确认请求中立即重放启动间隙的退出意图。
    await ipcInvoke(IPC_COMMANDS.acknowledgeQuitListener)
  } catch (error) {
    await barrier.initializationFailed(error)
  }
}

/** 返回退出被阻止时的诊断；Swift 的窗口关闭与应用退出共享宿主退出意图。 */
export function useExitFlush(): string | null {
  const [blocked, setBlocked] = useState<string | null>(null)
  useEffect(() => {
    const host = detectHostKind()
    if (host === 'browser') return
    const barrier = createExitBarrier(host, setBlocked)
    void installExitListeners(host, barrier)
    return barrier.dispose
  }, [])
  return blocked
}
