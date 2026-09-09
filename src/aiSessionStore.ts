import { normalizeAiSession, type AiSession } from './editor/ai/session'
import { enqueueProjectWrite } from './projectStore/saveChain'

const memorySessions = new Map<string, AiSession>()

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** AI 会话恢复结果：归一化后的历史与修复写回失败信息独立保留。 */
export interface AiSessionLoadResult {
  session: AiSession
  repairError: string | null
}

/** 读取项目独立 AI 历史；缺少会话文件的旧项目返回空历史。 */
export async function loadAiSession(id: string): Promise<AiSessionLoadResult> {
  if (!isTauri) {
    return { session: memorySessions.get(id) ?? { schemaVersion: 1, entries: [] }, repairError: null }
  }
  const { invoke } = await import('@tauri-apps/api/core')
  const { session, repaired } = normalizeAiSession(await invoke<unknown>('load_ai_session', { id }))
  if (!repaired) return { session, repairError: null }
  try {
    await saveAiSession(id, session)
    return { session, repairError: null }
  } catch (err) {
    console.warn('[aiSession] 修复会话回写失败', err)
    return { session, repairError: String(err) }
  }
}

/** 串行保存同一项目的 AI 历史，并服从项目删除墓碑，避免迟到写入复活项目。 */
export function saveAiSession(id: string, session: AiSession): Promise<void> {
  if (!isTauri) {
    memorySessions.set(id, session)
    return Promise.resolve()
  }
  return enqueueProjectWrite(id, async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('save_ai_session', { id, session })
  })
}

/** 删除内存回退的项目会话；Tauri 路径由 delete_project 删除整个项目目录。 */
export function deleteAiSession(id: string): void {
  memorySessions.delete(id)
}
