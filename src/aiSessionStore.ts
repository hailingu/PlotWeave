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

/** 载荷写入时刻（毫秒）：主文件与恢复副本各自记录，载入时以较新者为准。
 * 权威保存成功但恢复副本清除/改写失败时，陈旧副本的写入时刻一定更早，
 * 因此不会在下次载入时压过权威会话。 */
function savedAtOf(raw: unknown): number {
  if (typeof raw !== 'object' || raw === null) return 0
  const at = (raw as { savedAt?: unknown }).savedAt
  return typeof at === 'number' && Number.isFinite(at) ? at : 0
}

/** 读取项目独立 AI 历史。主文件与恢复副本都读，取写入时刻较新者——恢复
 * 副本只在主文件保存失败后写入，正常情况下必然更新；但权威保存成功后
 * 副本清除/改写失败时，副本是陈旧的，必须让较新的权威会话胜出。载入后
 * 立即尝试提升为权威副本，失败则把恢复副本继续留在原位并如实上报。 */
export async function loadAiSession(id: string): Promise<AiSessionLoadResult> {
  if (!isTauri) {
    return {
      session: memorySessions.get(id) ?? { schemaVersion: 1, entries: [] },
      repairError: null,
      recovered: false,
    }
  }
  const { invoke } = await import('@tauri-apps/api/core')
  let mainError: unknown
  const mainRaw = await invoke<unknown>('load_ai_session', { id }).catch((err: unknown) => {
    mainError = err
    return undefined
  })
  // 恢复副本读取失败（损坏/被替换）不得阻断权威会话文件回退
  const recoveryRaw = await invoke<unknown>('load_ai_session_recovery', { id }).catch(
    (err: unknown) => {
      console.warn('[aiSession] 恢复副本读取失败，回退权威会话文件', err)
      return null
    },
  )
  const recovered =
    recoveryRaw != null && (mainRaw === undefined || savedAtOf(recoveryRaw) > savedAtOf(mainRaw))
  // 权威文件读取失败且无可用恢复副本：显式上浮，不把损坏静默当成空历史
  if (!recovered && mainRaw === undefined) throw mainError
  const raw = recovered ? recoveryRaw : mainRaw
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
    await invoke('stash_ai_session_recovery', { id, session: { ...session, savedAt: Date.now() } })
  } catch (err) {
    console.warn('[aiSession] 恢复副本写入失败，内存副本仍待重试', err)
  }
}

/** 串行保存同一项目的 AI 历史，并服从项目删除墓碑，避免迟到写入复活项目。
 * 失败在**同一条项目写链内**先尽力写恢复副本再上抛：链屏障（加载前
 * waitForSaveChainIdle）落定时副本必然已就位，迟到的旧保存也不可能在新
 * 保存清除副本之后再写入陈旧内容。副本使该历史跨进程存活，主文件保存
 * 成功后由 Rust 侧清除。 */
export async function saveAiSession(id: string, session: AiSession): Promise<void> {
  if (!isTauri) {
    memorySessions.set(id, session)
    return
  }
  await enqueueProjectWrite(id, async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    try {
      await invoke('save_ai_session', { id, session: { ...session, savedAt: Date.now() } })
    } catch (err) {
      await stashRecovery(id, session)
      throw err
    }
  })
}

/** 删除内存回退的项目会话；Tauri 路径由 delete_project 删除整个项目目录
 * 与恢复副本。 */
export function deleteAiSession(id: string): void {
  memorySessions.delete(id)
}
