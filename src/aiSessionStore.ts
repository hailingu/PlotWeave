/** 项目 AI 会话的单主文件持久化：失败保留内存，后续编辑、重开或退出时
 * 可重试；不维护恢复副本、后台重试或跨进程版本协议（issue #47）。 */
import { normalizeAiSession, type AiSession } from './editor/ai/session'
import { enqueueProjectWrite } from './projectStore/saveChain'

const memorySessions = new Map<string, AiSession>()
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** 加载结果：可用历史及文件/条目损坏的可见诊断；读取本身不写回文件。 */
export interface AiSessionLoadResult {
  session: AiSession
  repairError: string | null
}

/** 待保存快照由本模块持有至最新写入成功或项目删除，不随面板卸载消失。 */
const pendingSessions = new Map<string, { session: AiSession }>()
const inFlightSaves = new Map<string, Promise<void>>()
const savedListeners = new Set<(id: string) => void>()

/** 订阅最新会话保存成功，供退出重试后同步清除界面错误和保留快照。 */
export function onAiSessionSaved(listener: (id: string) => void): () => void {
  savedListeners.add(listener)
  return () => savedListeners.delete(listener)
}

/** 读取唯一主文件；缺失为空历史，损坏条目隔离，I/O 错误交给界面提示。 */
export async function loadAiSession(id: string): Promise<AiSessionLoadResult> {
  if (!isTauri) {
    return {
      session: memorySessions.get(id) ?? { schemaVersion: 1, entries: [] },
      repairError: null,
    }
  }
  const { invoke } = await import('@tauri-apps/api/core')
  const result = await invoke<{ session: unknown; corrupt: boolean }>('load_ai_session', { id })
  const { session, repaired } = normalizeAiSession(result.session)
  return {
    session,
    repairError: result.corrupt || repaired
      ? 'AI 会话文件存在损坏，已保留可用历史；后续保存成功时将更新主文件'
      : null,
  }
}

/** 保存进入项目共享写入/删除链；失败上浮并保留最新快照，无额外写入或定时器。 */
export async function saveAiSession(id: string, session: AiSession): Promise<void> {
  if (!isTauri) {
    memorySessions.set(id, session)
    return
  }
  const pending = { session }
  pendingSessions.set(id, pending)
  const write = enqueueProjectWrite(id, async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('save_ai_session', { id, session })
    if (pendingSessions.get(id) === pending) {
      pendingSessions.delete(id)
      savedListeners.forEach((listener) => listener(id))
    }
  })
  inFlightSaves.set(id, write)
  const settle = () => {
    if (inFlightSaves.get(id) === write) inFlightSaves.delete(id)
  }
  void write.then(settle, settle)
  await write
}

/** 有在途保存或未保存快照时，正常退出需要等待并展示失败。 */
export function hasPendingAiSessionSaves(): boolean {
  return inFlightSaves.size > 0 || pendingSessions.size > 0
}

/** 等待在途写入，每项目最多重试一次主文件；仍失败则返回项目 id。
 * 等待期间加入的新保存也必须完成，不以过期队列快照放行退出。 */
export async function flushPendingAiSessionSaves(): Promise<string[]> {
  const retried = new Set<string>()
  for (;;) {
    await Promise.allSettled(Array.from(inFlightSaves.values()))
    if (inFlightSaves.size > 0) continue
    for (const [id, pending] of Array.from(pendingSessions)) {
      if (retried.has(id) || pendingSessions.get(id) !== pending) continue
      retried.add(id)
      try {
        await saveAiSession(id, pending.session)
      } catch {
        // 保留快照并交给退出界面提示，不进行自动循环重试。
      }
    }
    if (inFlightSaves.size === 0) break
  }
  return Array.from(pendingSessions.keys())
}

/** 项目删除成功后清除进程内会话；主文件随项目目录一起删除。 */
export function deleteAiSession(id: string): void {
  memorySessions.delete(id)
  pendingSessions.delete(id)
}
