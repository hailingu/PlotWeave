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
/** 会话权威落盘成功的订阅者：后台重试补写成功（不经过 UI 层保存通道）
 * 时，面板错误与保留快照只有靠此通知才能清除；用户通道的保存成功同样
 * 通知——清理动作幂等，与 UI 层自己的成功尾巴重复执行无害。 */
const savedListeners = new Set<(id: string) => void>()

/** 订阅会话权威落盘成功（最新代次），返回退订函数。 */
export function onAiSessionSaved(listener: (id: string) => void): () => void {
  savedListeners.add(listener)
  return () => savedListeners.delete(listener)
}
/** 尚未落定（排队/在途）的保存：关闭屏障必须等它落定后再判断，否则
 * 刚变更的会话在主文件与副本写入之前就被放行退出。 */
const inFlightSaves = new Map<string, Promise<void>>()
/** 主文件与恢复副本都写失败的会话：唯一副本只在内存，关闭屏障据此阻止
 * 退出；副本写入成功（跨进程可恢复）则不阻止，避免永远关不掉窗口。 */
const unrecoverableSessions = new Set<string>()
/** 新旧未知门禁（历轮评审修复）：载入时任一副本不可读即登记——此后该
 * 项目的一切会话保存整次暂缓，不写盘、不定序、不登记重试。否则保存
 * 失败路径把序号定在未知基线之上（副本改写 + 重试逐次自增），不可读
 * 副本恢复可读后，迟到写入终将压过其未知序号、用旧基线历史覆盖更新
 * 副本。两副本可读的重新载入即解除；编辑保留在会话与 App 保留区。
 * 损坏（不可解析/信封非法）的恢复副本不进门禁——它与 Rust 侧顺序守卫
 * 同口径按可安全替换归类（RecoveryCopy 契约）。 */
const orderingUnknownSessions = new Set<string>()
/** 新旧未知期间被整次暂缓的会话快照（评审 pullrequestreview-5161801056）：
 * 编辑只存在于内存——不得写盘（序号不得定在未知基线上），但退出屏障
 * 必须知道它们的存在，否则窗口关闭/应用退出会静默丢弃用户编辑。暂缓
 * 保存的重试落定后同项目的既有登记可能仍在（宁过分阻断也不丢编辑）；
 * 两副本可读的重新载入或删除项目时清出。 */
const orderingBlockedSessions = new Map<string, AiSession>()

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

/** `load_ai_session` / `load_ai_session_recovery` 的 SessionCopy 契约
 * （Rust 侧同名单义）：`session` 为 null 表示缺失或损坏（损坏时 `corrupt`
 * 置位，按可安全替换归类——无法被任何进程载入的内容没有可丢失的历史）。 */
function copySessionOf(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return null
  return (result as { session?: unknown }).session ?? null
}

function copyCorruptOf(result: unknown): boolean {
  return (
    typeof result === 'object' && result !== null && (result as { corrupt?: unknown }).corrupt === true
  )
}

type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>

/** 从磁盘两副本续起写入序号（进程内首次写入早于任何 load 时的兜底）。
 * 等待 IPC 期间内存序号可能已被并发保存推进：取大合并，不回拨。 */
async function seedWriteSeq(id: string, invoke: Invoke): Promise<number> {
  const [main, recovery] = await Promise.all([
    invoke('load_ai_session', { id }).catch(() => null),
    invoke('load_ai_session_recovery', { id }).catch(() => null),
  ])
  return mergeWriteSeq(id, Math.max(seqOf(copySessionOf(main)), seqOf(copySessionOf(recovery))))
}

/** 磁盘快照序号与内存序号取大合并，返回合并值：乱序返回的并发载入不得
 * 把序号回拨——回拨后的下一次保存会与权威文件同号，主保存失败时副本以
 * 相同序号落盘，重开时副本因不严格大于主文件而被忽略，新历史丢失。 */
function mergeWriteSeq(id: string, disk: number): number {
  const merged = Math.max(writeSeqs.get(id) ?? 0, disk)
  writeSeqs.set(id, merged)
  return merged
}

/** 下一写入序号：单调递增，同进程内并发写入由项目写链串行化。 */
async function nextWriteSeq(id: string, invoke: Invoke): Promise<number> {
  const current = writeSeqs.has(id) ? (writeSeqs.get(id) as number) : await seedWriteSeq(id, invoke)
  const next = current + 1
  writeSeqs.set(id, next)
  return next
}

/** 磁盘两副本的读取与选源判定（loadAiSession 前半）：主文件与恢复副本
 * 各自捕获读取错误；写入序号与内存取大合并（乱序载入不得回拨，见
 * mergeWriteSeq）；主文件不可读且无可用副本时上浮原始错误。两副本的
 * 损坏（corrupt）与不可读（Err）都分开判定：损坏按可安全替换归类，
 * 不进新旧未知门禁（评审 pullrequestreview-5161978174 把主文件补齐到
 * 与恢复副本同口径）。 */
interface SessionCopies {
  raw: unknown
  mainError: unknown
  mainUnreadable: boolean
  mainCorrupt: boolean
  recovered: boolean
  recoveryUnreadable: boolean
  recoveryCorrupt: boolean
  recoveryError: unknown
}

async function readSessionCopies(id: string, invoke: Invoke): Promise<SessionCopies> {
  let mainError: unknown
  let mainFailed = false
  const mainResult = await invoke('load_ai_session', { id }).catch((err: unknown) => {
    mainError = err
    mainFailed = true
    return null
  })
  const mainRaw = copySessionOf(mainResult)
  const mainCorrupt = !mainFailed && copyCorruptOf(mainResult)
  if (mainCorrupt) {
    console.warn('[aiSession] 权威会话文件损坏（不可解析），按可替换处理：保存成功时将被覆盖修复')
  }
  // 恢复副本读取失败（权限/瞬态 I/O）时新旧无法确定：不得当作「无副本」
  // 继续——权威回写会清掉可能是唯一新副本的历史；损坏（corrupt）则按
  // 可安全替换归类（SessionCopy 契约），照常以权威历史继续
  let recoveryError: unknown
  let recoveryFailed = false
  const recoveryResult = await invoke('load_ai_session_recovery', { id }).catch(
    (err: unknown) => {
      recoveryError = err
      recoveryFailed = true
      return null
    },
  )
  const recoveryRaw = copySessionOf(recoveryResult)
  const recoveryCorrupt = !recoveryFailed && copyCorruptOf(recoveryResult)
  if (recoveryCorrupt) {
    console.warn('[aiSession] 恢复副本损坏（不可解析），按可替换处理：保存成功后将被清除或替换')
  }
  mergeWriteSeq(id, Math.max(seqOf(mainRaw), seqOf(recoveryRaw)))
  const mainUnreadable = mainFailed
  // 损坏主文件无法提供内容与序号：任何可用恢复副本胜出（提升写回按可
  // 替换覆盖修复主文件）；主文件可读时仍取序号较大者
  const recovered =
    recoveryRaw != null &&
    (mainUnreadable || mainCorrupt || seqOf(recoveryRaw) > seqOf(mainRaw))
  // 任一副本不可读（真实 I/O 失败）即新旧未知：登记保存门禁（两副本可读
  // 的载入会解除，同时清出退出阻断登记）；损坏（可替换）不登记
  if (recoveryFailed || (recovered && mainUnreadable)) orderingUnknownSessions.add(id)
  else {
    orderingUnknownSessions.delete(id)
    orderingBlockedSessions.delete(id)
  }
  // 权威文件读取失败（真实 I/O）且无可用恢复副本：显式上浮，不静默当空历史
  if (!recovered && mainUnreadable) {
    orderingUnknownSessions.add(id)
    throw mainError
  }
  return {
    raw: recovered ? recoveryRaw : mainRaw,
    mainError,
    mainUnreadable,
    mainCorrupt,
    recovered,
    recoveryUnreadable: recoveryFailed,
    recoveryCorrupt,
    recoveryError,
  }
}

/** 归一化与提升/修复写回（loadAiSession 后半）：干净会话直接返回；主文件
 * 真实 I/O 不可读时暂缓一切写回（见 loadAiSession 的整体契约）；其余
 * （含损坏主文件——可安全替换）尝试写回，失败如实上报且陈旧覆盖由写入
 * 边界的顺序守卫拦截。 */
async function promoteLoadedSession(
  id: string,
  copies: SessionCopies,
): Promise<AiSessionLoadResult> {
  const { raw, mainError, mainUnreadable, mainCorrupt, recovered, recoveryCorrupt } = copies
  const { session, repaired } = normalizeAiSession(raw)
  if (!recovered && !repaired) {
    // 损坏副本仍在磁盘上但无任何可丢失的历史：如实提示，下次保存成功
    // 时由 Rust 侧覆盖/清除（自愈）；走写回路径时无须提示（已被替换/清除）
    const notes = [
      ...(mainCorrupt
        ? ['权威会话文件损坏（不可解析），已按空历史打开：下次保存成功时将自动修复该文件']
        : []),
      ...(recoveryCorrupt
        ? ['AI 会话恢复副本损坏（不可解析），已忽略：下次保存成功时将自动清除该副本']
        : []),
    ]
    return {
      session,
      repairError: notes.length > 0 ? notes.join('；') : null,
      recovered: false,
      recoveryUnreadable: false,
      authoritativeUnreadable: false,
    }
  }
  // 权威文件不可读时不得发起提升/修复写回：写入边界会拒绝（序号未知），
  // 而保存失败路径会把当前恢复内容（可能是权威更新前的陈旧副本）带递增
  // 序号写回恢复副本并登记重试——权威文件恢复可读后，重试终将携带不小于
  // 其序号的写入，用陈旧历史覆盖更新的权威会话。展示恢复历史、暂缓一切
  // 写回，待用户检查磁盘后重开项目重新判定新旧。
  if (recovered && mainUnreadable) {
    return {
      session,
      repairError: String(mainError),
      recovered: true,
      recoveryUnreadable: false,
      authoritativeUnreadable: true,
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
    // 主文件可读（否则上方已提前返回）：提升/修复写回失败如实上报，
    // 陈旧副本的覆盖风险由写入边界的顺序守卫拦截
    console.warn('[aiSession] 会话回写失败', err)
    return {
      session,
      repairError: String(err),
      recovered,
      recoveryUnreadable: false,
      authoritativeUnreadable: false,
    }
  }
}

/** 读取项目独立 AI 历史。主文件与恢复副本都读，取写入序号较大者——恢复
 * 副本只在主文件保存失败后写入，正常情况下序号更大；但权威保存成功后
 * 副本清除/改写失败时，副本是陈旧的，必须让较新的权威会话胜出。载入后
 * （主文件可读时）立即尝试提升为权威副本，失败则把恢复副本继续留在原位
 * 并如实上报；主文件不可读时只展示恢复历史，不发起任何写回。 */
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
  const copies = await readSessionCopies(id, invoke as Invoke)
  if (copies.recoveryUnreadable) {
    // 展示权威历史但明确告知并暂缓回写：提升/修复写回都不发起（写入边界
    // 的顺序守卫也会拒绝覆盖不可读副本）
    console.warn('[aiSession] 恢复副本读取失败，暂缓保存以免覆盖更新历史', copies.recoveryError)
    const { session } = normalizeAiSession(copies.raw)
    return {
      session,
      repairError: `AI 会话恢复副本读取失败，已暂缓保存以免覆盖更新的历史：${String(copies.recoveryError)}`,
      recovered: false,
      recoveryUnreadable: true,
      authoritativeUnreadable: false,
    }
  }
  return promoteLoadedSession(id, copies)
}

/** 重读磁盘两副本的最大写入序号（保存被拒后的冲突检测）：读失败按 0——
 * 不可读副本由写入边界的既有守卫另行拒绝，不误判为冲突。 */
async function diskWriteSeqMax(id: string, invoke: Invoke): Promise<number> {
  const [main, recovery] = await Promise.all([
    invoke('load_ai_session', { id }).catch(() => null),
    invoke('load_ai_session_recovery', { id }).catch(() => null),
  ])
  return Math.max(seqOf(copySessionOf(main)), seqOf(copySessionOf(recovery)))
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
  // 新旧未知门禁（见 orderingUnknownSessions）：变更与重试一律整次暂缓——
  // 序号不得定在未知基线之上；编辑保留在会话与 App 保留区，待重开定序。
  // 暂缓的快照同时登记进退出屏障（orderingBlockedSessions）：它只存在于
  // 内存，窗口关闭/应用退出若不知情会静默丢弃用户编辑
  if (orderingUnknownSessions.has(id)) {
    orderingBlockedSessions.set(id, session)
    throw new Error('AI 会话新旧未知（权威文件或恢复副本不可读），已暂缓保存：请检查磁盘后重开项目')
  }
  const generation = (sessionGenerations.get(id) ?? 0) + 1
  sessionGenerations.set(id, generation)
  const write = enqueueProjectWrite(id, async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const writeSeq = await nextWriteSeq(id, invoke as Invoke)
    try {
      await invoke('save_ai_session', { id, session: { ...session, writeSeq } })
      if (sessionGenerations.get(id) === generation) {
        clearSessionRetry(id)
        // 最新代次已权威落盘：通知 UI 层清除保存失败错误与保留快照（后台
        // 重试补写不经 UI 通道，只有这里能告知）；代次已前进则本次成功
        // 属于旧会话，不得误清新失败的错误
        savedListeners.forEach((listener) => listener(id))
      }
    } catch (err) {
      // 被拒可能只是序号陈旧（另一进程已写更新历史——无单实例约束）：
      // 重读两副本序号，磁盘已不小于本次写入即冲突。不得写副本、不得登记
      // 重试——逐次自增的重试终将压过磁盘序号，把旧历史写回新会话，绕过
      // 顺序守卫；清出登记并上浮原错误，让用户重开项目载入更新的历史
      const diskMax = await diskWriteSeqMax(id, invoke as Invoke)
      if (diskMax >= writeSeq) {
        if (sessionGenerations.get(id) === generation) clearSessionRetry(id)
        throw err
      }
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

/** 关闭屏障是否需要介入：有排队/在途的保存，存在既未写入权威文件也
 * 未写入恢复副本的会话（唯一副本只在内存），或存在新旧未知期间被整次
 * 暂缓的编辑（同样只在内存）。副本已落盘的待重试会话不阻止退出——它
 * 跨进程可恢复。 */
export function hasPendingAiSessionSaves(): boolean {
  return (
    inFlightSaves.size > 0 ||
    unrecoverableSessions.size > 0 ||
    orderingBlockedSessions.size > 0
  )
}

/** 冲刷落定后的退出阻断项：`unrecoverable` = 主文件与副本都写失败且重试
 * 仍失败；`orderingBlocked` = 新旧未知期间被暂缓的编辑（不得写盘，重开
 * 项目确立定序后才可落盘）。任一非空都不得放行退出。 */
export interface AiSessionFlushBlock {
  unrecoverable: string[]
  orderingBlocked: string[]
}

/** 冲刷到固定点：等在途保存落定（失败项在其内登记）并重试待重试会话。
 * 等待与重试期间用户仍可能新增保存（窗口未销毁、面板可交互），同项目的
 * 后来者会替换 Map 项而不加入先前捕获的数组——只等一次快照会在新保存
 * 仍在途时误判已排空而放行退出，故循环重查到静止（同 waitForSaveChainIdle
 * 的等静止语义）。每个登记项每次冲刷只重试一次：持续失败者交还固定节律
 * 定时器，避免冲刷自旋。暂缓（新旧未知）的编辑不重试写盘，只作为阻断项
 * 上浮。返回仍阻断退出的项目 id——非空即不得放行退出。 */
export async function flushPendingAiSessionSaves(): Promise<AiSessionFlushBlock> {
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
        // 状态（不可恢复标记/暂缓阻断登记）已在 saveAiSession 内更新
      }
    }
    if (inFlightSaves.size === 0) break
  }
  return {
    unrecoverable: Array.from(unrecoverableSessions),
    orderingBlocked: Array.from(orderingBlockedSessions.keys()),
  }
}

/** 删除内存回退的项目会话；Tauri 路径由 delete_project 删除整个项目目录
 * 与恢复副本。 */
export function deleteAiSession(id: string): void {
  memorySessions.delete(id)
  clearSessionRetry(id)
  orderingUnknownSessions.delete(id)
  orderingBlockedSessions.delete(id)
}
