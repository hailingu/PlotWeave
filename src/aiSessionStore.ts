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
  /** 权威会话文件存在但读取失败（缺失会返回空会话）：其写入序号未知，
   * 不得用恢复副本提升覆盖——展示恢复历史并暂缓写回，写入边界同样拒绝
   * 覆盖不可读主文件。 */
  authoritativeUnreadable: boolean
}

/** 每项目会话写入序号（单调计数）：主文件与恢复副本各自携带，载入取序号
 * 较大者。副本只在主文件保存失败后写入，序号必然更大；权威保存成功而
 * 副本清除/改写失败时副本序号更小，较新的权威会话胜出。序号与墙上时钟
 * 无关——时钟回拨或同毫秒写入都不会错序。跨进程从磁盘两副本的最大值续起。 */
const writeSeqs = new Map<string, number>()

/** 未落盘会话的进程内重试（与画布保存链同款节律）：保存失败后按固定节律
 * 重试直到成功或登记被更新/清出——不依赖下一次会话变更或编辑器重挂载。
 * 进程退出仍会丢失；退出前的冲刷由窗口关闭屏障（useExitFlush）负责。 */
const SESSION_RETRY_DELAY_MS = 5000
const pendingRetrySessions = new Map<string, AiSession>()
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const sessionGenerations = new Map<string, number>()
/** 尚未落定（排队/在途）的保存：关闭屏障必须等它落定后再判断，否则
 * 刚变更的会话在主文件与副本写入之前就被放行退出。 */
const inFlightSaves = new Map<string, Promise<void>>()
/** 主文件与恢复副本都写失败的会话：唯一副本只在内存，关闭屏障据此阻止
 * 退出；副本写入成功（跨进程可恢复）则不阻止，避免永远关不掉窗口。 */
const unrecoverableSessions = new Set<string>()

/** 清出重试登记、定时器与不可恢复标记（保存成功、删除项目时调用）。 */
function clearSessionRetry(id: string): void {
  const timer = retryTimers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    retryTimers.delete(id)
  }
  pendingRetrySessions.delete(id)
  unrecoverableSessions.delete(id)
}

/** 按固定节律重试登记会话：旧代次定时器一律作废并替换（否则旧定时器
 * 先触发时代次不符直接退出，最新登记将无人重试）；代次已前进则本次作废。 */
function scheduleSessionRetry(id: string, generation: number): void {
  const stale = retryTimers.get(id)
  if (stale !== undefined) {
    clearTimeout(stale)
    retryTimers.delete(id)
  }
  retryTimers.set(
    id,
    setTimeout(() => {
      retryTimers.delete(id)
      if (sessionGenerations.get(id) !== generation) return
      const session = pendingRetrySessions.get(id)
      if (session === undefined) return
      void saveAiSession(id, session).catch(() => undefined)
    }, SESSION_RETRY_DELAY_MS),
  )
}

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
      authoritativeUnreadable: false,
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
  const mainUnreadable = mainRaw === undefined
  const recovered =
    recoveryRaw != null && (mainUnreadable || seqOf(recoveryRaw) > seqOf(mainRaw))
  // 权威文件读取失败且无可用恢复副本：显式上浮，不把损坏静默当成空历史
  if (!recovered && mainUnreadable) throw mainError
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
      authoritativeUnreadable: false,
    }
  }
  const raw = recovered ? recoveryRaw : mainRaw
  const { session, repaired } = normalizeAiSession(raw)
  if (!recovered && !repaired) {
    return {
      session,
      repairError: null,
      recovered: false,
      recoveryUnreadable: false,
      authoritativeUnreadable: false,
    }
  }
  try {
    await saveAiSession(id, session)
    return {
      session,
      repairError: null,
      recovered: false,
      recoveryUnreadable: false,
      authoritativeUnreadable: false,
    }
  } catch (err) {
    // 权威文件不可读时提升会被写入边界的顺序守卫拒绝：序号未知，不得用
    // 恢复副本覆盖可能更新的权威历史；展示恢复历史并禁止自动重试
    console.warn('[aiSession] 会话回写失败', err)
    return {
      session,
      repairError: String(err),
      recovered,
      recoveryUnreadable: false,
      authoritativeUnreadable: mainUnreadable,
    }
  }
}

/** 主文件保存失败时尽力写入恢复副本（跨进程保留的唯一拷贝），返回副本
 * 是否落盘成功——副本成功即该历史已跨进程可恢复，关闭屏障无须再阻止
 * 退出；副本写入同样失败时仍上抛原始保存错误，内存副本由调用方保留。
 * 副本沿用本次写入序号：它的序号大于主文件内的序号，载入时胜出。 */
async function stashRecovery(
  id: string,
  session: AiSession,
  writeSeq: number,
  invoke: Invoke,
): Promise<boolean> {
  try {
    await invoke('stash_ai_session_recovery', { id, session: { ...session, writeSeq } })
    return true
  } catch (err) {
    console.warn('[aiSession] 恢复副本写入失败，内存副本仍待重试', err)
    return false
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
  const generation = (sessionGenerations.get(id) ?? 0) + 1
  sessionGenerations.set(id, generation)
  const write = enqueueProjectWrite(id, async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const writeSeq = await nextWriteSeq(id, invoke as Invoke)
    try {
      await invoke('save_ai_session', { id, session: { ...session, writeSeq } })
      if (sessionGenerations.get(id) === generation) clearSessionRetry(id)
    } catch (err) {
      const stashed = await stashRecovery(id, session, writeSeq, invoke as Invoke)
      // 按节律重试直到成功（副本成功时用于补写权威文件，两者都失败时是
      // 唯一兜底）；不可恢复标记只在两者都失败时置位，供关闭屏障阻止退出
      if (sessionGenerations.get(id) === generation) {
        pendingRetrySessions.set(id, session)
        if (stashed) unrecoverableSessions.delete(id)
        else unrecoverableSessions.add(id)
        scheduleSessionRetry(id, generation)
      }
      throw err
    }
  })
  inFlightSaves.set(id, write)
  const settle = () => {
    if (inFlightSaves.get(id) === write) inFlightSaves.delete(id)
  }
  void write.then(settle, settle)
  await write
}

/** 关闭屏障是否需要介入：有排队/在途的保存，或存在既未写入权威文件也
 * 未写入恢复副本的会话（唯一副本只在内存）。副本已落盘的待重试会话不
 * 阻止退出——它跨进程可恢复。 */
export function hasPendingAiSessionSaves(): boolean {
  return inFlightSaves.size > 0 || unrecoverableSessions.size > 0
}

/** 冲刷到固定点：等在途保存落定（失败项在其内登记）并重试待重试会话。
 * 等待与重试期间用户仍可能新增保存（窗口未销毁、面板可交互），同项目的
 * 后来者会替换 Map 项而不加入先前捕获的数组——只等一次快照会在新保存
 * 仍在途时误判已排空而放行退出，故循环重查到静止（同 waitForSaveChainIdle
 * 的等静止语义）。每个登记项每次冲刷只重试一次：持续失败者交还固定节律
 * 定时器，避免冲刷自旋。返回仍不可恢复的项目 id——非空即不得放行退出。 */
export async function flushPendingAiSessionSaves(): Promise<string[]> {
  const retried = new Set<string>()
  for (;;) {
    await Promise.allSettled(Array.from(inFlightSaves.values()))
    // 快照后遍历：失败项会在 saveAiSession 内重新登记，直接遍历可能重复访问
    for (const [id, session] of Array.from(pendingRetrySessions)) {
      if (retried.has(id)) continue
      retried.add(id)
      try {
        await saveAiSession(id, session)
      } catch {
        // 状态（不可恢复标记）已在 saveAiSession 内更新
      }
    }
    if (inFlightSaves.size === 0) break
  }
  return Array.from(unrecoverableSessions)
}

/** 删除内存回退的项目会话；Tauri 路径由 delete_project 删除整个项目目录
 * 与恢复副本。 */
export function deleteAiSession(id: string): void {
  memorySessions.delete(id)
  clearSessionRetry(id)
}
