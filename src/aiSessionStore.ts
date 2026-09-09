import { normalizeAiSession, type AiSession } from './editor/ai/session'
import { enqueueProjectWrite } from './projectStore/saveChain'

const memorySessions = new Map<string, AiSession>()

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** AI 会话恢复结果：归一化后的历史、修复写回失败信息与恢复副本来源。
 * `recovered` 为真表示权威会话文件仍未恢复，当前历史只存在于恢复副本
 * （主文件保存失败后写入，跨进程保留），需在界面上如实告知。 */
export interface AiSessionLoadResult {
  session: AiSession
  repairError: string | null
  recovered: boolean
}

/** 读取项目独立 AI 历史。恢复副本优先于权威文件——它只在主文件保存失败
 * 后写入，一定比磁盘上的旧会话新；载入后立即尝试提升为权威副本，失败则
 * 把恢复副本继续留在原位并如实上报。 */
export async function loadAiSession(id: string): Promise<AiSessionLoadResult> {
  if (!isTauri) {
    return {
      session: memorySessions.get(id) ?? { schemaVersion: 1, entries: [] },
      repairError: null,
      recovered: false,
    }
  }
  const { invoke } = await import('@tauri-apps/api/core')
  // 恢复副本读取失败（损坏/被替换）不得阻断权威会话文件回退
  const recoveredRaw = await invoke<unknown>('load_ai_session_recovery', { id }).catch(
    (err: unknown) => {
      console.warn('[aiSession] 恢复副本读取失败，回退权威会话文件', err)
      return null
    },
  )
  const recovered = recoveredRaw != null
  const raw = recovered ? recoveredRaw : await invoke<unknown>('load_ai_session', { id })
  const { session, repaired } = normalizeAiSession(raw)
  if (!recovered && !repaired) return { session, repairError: null, recovered: false }
  try {
    await saveAiSession(id, session)
    return { session, repairError: null, recovered: false }
  } catch (err) {
    console.warn('[aiSession] 会话回写失败', err)
    return { session, repairError: String(err), recovered }
  }
}

/** 主文件保存失败时尽力写入恢复副本（跨进程保留的唯一拷贝）；副本写入
 * 同样失败时仍上抛原始保存错误，内存副本由调用方保留。 */
async function stashRecovery(id: string, session: AiSession): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('stash_ai_session_recovery', { id, session })
  } catch (err) {
    console.warn('[aiSession] 恢复副本写入失败，内存副本仍待重试', err)
  }
}

/** 串行保存同一项目的 AI 历史，并服从项目删除墓碑，避免迟到写入复活项目。
 * 失败先尽力写恢复副本再上抛：调用方展示错误、保留内存历史，恢复副本使
 * 该历史跨进程存活（主文件保存成功后由 Rust 侧清除）。 */
export async function saveAiSession(id: string, session: AiSession): Promise<void> {
  if (!isTauri) {
    memorySessions.set(id, session)
    return
  }
  try {
    await enqueueProjectWrite(id, async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('save_ai_session', { id, session })
    })
  } catch (err) {
    await stashRecovery(id, session)
    throw err
  }
}

/** 删除内存回退的项目会话；Tauri 路径由 delete_project 删除整个项目目录
 * 与恢复副本。 */
export function deleteAiSession(id: string): void {
  memorySessions.delete(id)
}
