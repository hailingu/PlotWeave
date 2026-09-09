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
  /** 恢复副本存在但本次读取失败：新旧无法确定，已暂缓保存以免覆盖更新
   * 历史（写入边界另有顺序守卫），界面须如实告知且不得自动重试落盘。 */
  recoveryUnreadable: boolean
}

/** 每项目会话写入序号（单调计数）：主文件与恢复副本各自携带，载入取序号
 * 较大者。副本只在主文件保存失败后写入，序号必然更大；权威保存成功而
 * 副本清除/改写失败时副本序号更小，较新的权威会话胜出。序号与墙上时钟
 * 无关——时钟回拨或同毫秒写入都不会错序。跨进程从磁盘两副本的最大值续起。 */
const writeSeqs = new Map<string, number>()

/** 载荷写入序号：非负安全整数之外（含旧版本文件）一律视作 0。 */
function seqOf(raw: unknown): number {
  if (typeof raw !== 'object' || raw === null) return 0
  const seq = (raw as { writeSeq?: unknown }).writeSeq
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : 0
}

type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>

/** 从磁盘两副本续起写入序号（进程内首次写入早于任何 load 时的兜底）。 */
async function seedWriteSeq(id: string, invoke: Invoke): Promise<number> {
  const [main, recovery] = await Promise.all([
    invoke('load_ai_session', { id }).catch(() => null),
    invoke('load_ai_session_recovery', { id }).catch(() => null),
  ])
  const seq = Math.max(seqOf(main), seqOf(recovery))
  writeSeqs.set(id, seq)
  return seq
}

/** 下一写入序号：单调递增，同进程内并发写入由项目写链串行化。 */
async function nextWriteSeq(id: string, invoke: Invoke): Promise<number> {
  const current = writeSeqs.has(id) ? (writeSeqs.get(id) as number) : await seedWriteSeq(id, invoke)
  const next = current + 1
  writeSeqs.set(id, next)
  return next
}

/** 读取项目独立 AI 历史。主文件与恢复副本都读，取写入序号较大者——恢复
 * 副本只在主文件保存失败后写入，正常情况下序号更大；但权威保存成功后
 * 副本清除/改写失败时，副本是陈旧的，必须让较新的权威会话胜出。载入后
 * 立即尝试提升为权威副本，失败则把恢复副本继续留在原位并如实上报。 */
export async function loadAiSession(id: string): Promise<AiSessionLoadResult> {
  if (!isTauri) {
    return {
      session: memorySessions.get(id) ?? { schemaVersion: 1, entries: [] },
      repairError: null,
      recovered: false,
      recoveryUnreadable: false,
    }
  }
  const { invoke } = await import('@tauri-apps/api/core')
  let mainError: unknown
  const mainRaw = await invoke<unknown>('load_ai_session', { id }).catch((err: unknown) => {
    mainError = err
    return undefined
  })
  // 恢复副本读取失败（权限/瞬态 I/O/损坏）时新旧无法确定：不得当作
  // 「无副本」继续——权威回写会清掉可能是唯一新副本的历史
  let recoveryError: unknown
  let recoveryFailed = false
  const recoveryRaw = await invoke<unknown>('load_ai_session_recovery', { id }).catch(
    (err: unknown) => {
      recoveryError = err
      recoveryFailed = true
      return null
    },
  )
  writeSeqs.set(id, Math.max(seqOf(mainRaw), seqOf(recoveryRaw)))
  const recovered =
    recoveryRaw != null && (mainRaw === undefined || seqOf(recoveryRaw) > seqOf(mainRaw))
  // 权威文件读取失败且无可用恢复副本：显式上浮，不把损坏静默当成空历史
  if (!recovered && mainRaw === undefined) throw mainError
  if (recoveryFailed) {
    // 展示权威历史但明确告知并暂缓回写：提升/修复写回都不发起（写入边界
    // 的顺序守卫也会拒绝覆盖不可读副本）
    console.warn('[aiSession] 恢复副本读取失败，暂缓保存以免覆盖更新历史', recoveryError)
    const { session } = normalizeAiSession(mainRaw)
    return {
      session,
      repairError: `AI 会话恢复副本读取失败，已暂缓保存以免覆盖更新的历史：${String(recoveryError)}`,
      recovered: false,
      recoveryUnreadable: true,
    }
  }
  const raw = recovered ? recoveryRaw : mainRaw
  const { session, repaired } = normalizeAiSession(raw)
  if (!recovered && !repaired) {
    return { session, repairError: null, recovered: false, recoveryUnreadable: false }
  }
  try {
    await saveAiSession(id, session)
    return { session, repairError: null, recovered: false, recoveryUnreadable: false }
  } catch (err) {
    console.warn('[aiSession] 会话回写失败', err)
    return { session, repairError: String(err), recovered, recoveryUnreadable: false }
  }
}

/** 主文件保存失败时尽力写入恢复副本（跨进程保留的唯一拷贝）；副本写入
 * 同样失败时仍上抛原始保存错误，内存副本由调用方保留。副本沿用本次
 * 写入序号：它的序号大于主文件内的序号，载入时胜出。 */
async function stashRecovery(
  id: string,
  session: AiSession,
  writeSeq: number,
  invoke: Invoke,
): Promise<void> {
  try {
    await invoke('stash_ai_session_recovery', { id, session: { ...session, writeSeq } })
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
    const writeSeq = await nextWriteSeq(id, invoke as Invoke)
    try {
      await invoke('save_ai_session', { id, session: { ...session, writeSeq } })
    } catch (err) {
      await stashRecovery(id, session, writeSeq, invoke as Invoke)
      throw err
    }
  })
}

/** 删除内存回退的项目会话；Tauri 路径由 delete_project 删除整个项目目录
 * 与恢复副本。 */
export function deleteAiSession(id: string): void {
  memorySessions.delete(id)
}
