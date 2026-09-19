/**
 * §3.1 项目级保存链与删除墓碑（issue #39 自 projectStore.ts 拆出）：保存按
 * 项目串行（后保存者的内容永不早于先保存者落盘）；失败把最新文档登记为
 * 待重试并按固定节律后台重试——编辑器卸载/导航后组件不复存在，最新文档
 * 只存在于这里，瞬时故障（磁盘满/权限）不得永久丢编辑。重试绑定**保存
 * 代次**：每次入队自增，新保存一排队旧代次重试即作废——陈旧文档的重试
 * 不得后完成覆盖新内容。删除同样排进链：在途保存落定后才删，且先取消
 * 全部重试登记，已删项目不得被迟到的完成/重试复活。
 *
 * 可变状态归属（issue #162，工程标准「可变全局单例须登记有界生命周期与
 * 移除计划」的批准例外）：saveChains/pendingRetryDocs 等模块级可变表由
 * 本模块（保存协调器）独占所有，外部模块只经窄操作消费——
 * `pendingRetryDocOf`（查询）、`replacePendingRetryDoc`（同一性条件
 * 替换）、`saveChainTokenOf`（不透明链身份令牌，仅同值比较），不得直接
 * 读写 Map。生命周期：条目随保存失败登记、保存成功/删除落定清除，与
 * 进程同寿是产品目的（导航/卸载后最新未落盘文档只存于此）；移除计划：
 * 无——进程内保留即设计本身，若未来引入项目级显式关闭语义再评估。
 */
import { serializeProject } from '../model/convert'
import type { ProjectContent } from '../model/content'

const SAVE_RETRY_DELAY_MS = 5000
/** 项目 id → 保存链尾 Promise（模块私有，issue #162）：外部经
 * `saveChainTokenOf` 取不透明令牌做身份比较，不持有 Map 本身。 */
const saveChains = new Map<string, Promise<unknown>>()
/** 项目 id → 待重试的最新未落盘文档（模块私有，issue #162）：外部经
 * `pendingRetryDocOf` / `replacePendingRetryDoc` 消费。 */
const pendingRetryDocs = new Map<string, ProjectContent>()
/** 重试登记的触发器：定时器句柄 + 登记代次（触发时代次不符即自灭）。 */
const retryTimers = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; generation: number }
>()
const saveGenerations = new Map<string, number>()
/** 未落定的链上动作（保存/删除/附属写入，issue #119）：退出屏障的就绪探针
 * 与冲刷等待面。链条 Promise 长期留存于 saveChains（落定后也不清除），
 * 不能据此判断在途，须另行跟踪。 */
const unsettledChains = new Set<Promise<unknown>>()
/** 最近经重试确认落盘的登记文档（按 id，PR #174 评审）：同一文档对象的
 * 后续保存失败是冗余重写失败——磁盘已持有该内容，不再登记重试，避免
 * 假性「待保存」阻断退出。新内容（不同对象）照常登记。 */
const retryPersistedDocs = new Map<string, ProjectContent>()
/** 删除墓碑：删除开始即立——之后为该项目排队的任何保存被吸收，迟到的
 * 合并冲刷/重试不得重建 JSON 复活用户刚删的项目；删除落定（成功或失败）
 * 后清除，失败时项目仍在、可继续保存。 */
/** 删除墓碑（引用计数，PR #224 第八轮评审）：重叠的 enqueueDelete（如
 * duplicate 清理分支在首个删除活跃期再排队一笔）共享同一墓碑——每笔
 * 删除落定自减，计数归零才解除。Set 形态下第一笔的 finally 提前抹掉
 * 墓碑，重叠窗口内的迟到普通保存不再被吸收、越过仍在排队的删除以
 * create-if-missing 重建已删项目。 */
const deletingIds = new Map<string, number>()

/** 删除组级成功标记（PR #224 第十轮评审）：重叠删除中任一笔后端删除
 * 成功即置位——后续失败的回吐分支据此丢弃（而非重放）吸收的文档：
 * 项目已被成功笔移除，重放会以 create-if-missing 语义复活它，而保存
 * 调用方当初拿到的是「吸收为成功」。标记随墓碑计数归零一并清除。 */
const deleteSucceededIds = new Set<string>()
/** 删除期间被吸收的迟到保存：留存最新文档——删除失败（项目仍在磁盘）时
 * 回吐重存，否则该次冲刷已被上游视为成功，最新编辑既没落盘也无重试
 * 登记；删除成功即随项目一并丢弃，绝不复活已删项目。 */
const absorbedSaveDocs = new Map<string, ProjectContent>()

/** 删除墓碑期被吸收的附属数据写入（如 AI 会话保存）：按 id 留存最新写入
 * 闭包——删除失败（项目仍在磁盘）时重排执行，否则该次写入已被上游视为
 * 成功却从未落盘也无快照重试；删除成功即随项目一并丢弃，绝不复活已删
 * 项目。同 id 后到的写入取代先到的：闭包载荷为整体快照，只重放最新。 */
const absorbedProjectWrites = new Map<string, () => Promise<void>>()

/** 回吐重排失败监听器：回吐的写入是墓碑期吸收的迟到排队，原始调用方
 * 早已拿到成功应答、无从上浮失败——订阅方（如 AI 会话存储）由此把保留
 * 快照交给上层恢复通道。 */
export type ProjectWriteReplayFailureListener = (
  id: string,
  err: unknown,
) => void
const replayFailureListeners = new Set<ProjectWriteReplayFailureListener>()

/** 订阅删除失败后回吐重排的附属写入失败；返回退订函数。 */
export function onProjectWriteReplayFailure(
  listener: ProjectWriteReplayFailureListener,
): () => void {
  replayFailureListeners.add(listener)
  return () => replayFailureListeners.delete(listener)
}

/** 项目文档保存落定监听器：入参为落盘成功的项目 id。 */
export type ProjectSavedListener = (id: string) => void
const savedListeners = new Set<ProjectSavedListener>()

/** 订阅项目文档保存落定（issue #101）：链上每一次保存成功都通知——编辑器
 * 卸载冲刷/在途保存可以晚于返回首页的列表读取，保存失败登记后的后台重试
 * 成功也发生在编辑器卸载之后，首页摘要只能靠这条通知恢复到与磁盘一致。
 * 保存失败不通知（磁盘保持旧内容，首页不得虚报新摘要）。返回退订函数。 */
export function onProjectSaved(listener: ProjectSavedListener): () => void {
  savedListeners.add(listener)
  return () => savedListeners.delete(listener)
}

/** 保存落定通知的补发口（issue #101）：仅供不经保存链的内存回退路径在
 * 门面保存成功后调用；链上路径的通知由 enqueueSave 成功段自带。 */
export function notifyProjectSaved(id: string): void {
  savedListeners.forEach((listener) => listener(id))
}

/** 将项目附属数据的写入纳入与画布相同的保存/删除链。删除墓碑期的写入
 * 被吸收（登记最新闭包，删除失败时回吐），保证已删除项目不会因迟到的
 * 独立持久化操作重建目录。 */
export function enqueueProjectWrite(
  id: string,
  write: () => Promise<void>,
): Promise<void> {
  if (deletingIds.has(id)) {
    // 吸收但不丢弃：留存最新写入闭包，删除失败时回吐（见 enqueueDelete）
    absorbedProjectWrites.set(id, write)
    console.warn('[projectStore] 项目删除中，吸收附属数据写入', id)
    return Promise.resolve()
  }
  const run = (saveChains.get(id) ?? Promise.resolve()).catch(() => undefined)
  const next = run.then(write)
  trackChainSettle(next)
  saveChains.set(id, next)
  return next
}

/** 取消后台重试定时器（不触碰登记文档）：删除开场只需停摆定时器——墓碑
 * 期定时器即使触发也只会被 enqueueSave 吸收（不会复活已删项目），但停摆
 * 更干净；登记文档留待链落定处的全量清除与回吐判定。 */
function clearSaveRetryTimer(id: string): void {
  const entry = retryTimers.get(id)
  if (entry !== undefined) {
    clearTimeout(entry.timer)
    retryTimers.delete(id)
  }
}

function clearSaveRetry(id: string): void {
  clearSaveRetryTimer(id)
  pendingRetryDocs.delete(id)
}

/** 定时器到期与退出冲刷（flushPendingProjectSaves）共用的重试触发：代次
 * 仍是登记代次才重排入队——新保存排队即自增代次，旧登记由新代次自洽
 * （陈旧文档不得后完成覆盖新内容）。返回是否实际发起重存：无登记定时器
 * 或代次已前进均为空操作（false），调用方据此决定是否计入已尝试。 */
function fireSaveRetry(id: string): boolean {
  const entry = retryTimers.get(id)
  if (entry === undefined) return false
  clearSaveRetryTimer(id)
  if (saveGenerations.get(id) !== entry.generation) return false
  const doc = pendingRetryDocs.get(id)
  if (doc === undefined) return false
  void enqueueSave(id, doc).catch(() => undefined)
  return true
}

function scheduleSaveRetry(id: string, generation: number): void {
  clearSaveRetryTimer(id)
  retryTimers.set(id, {
    timer: setTimeout(() => fireSaveRetry(id), SAVE_RETRY_DELAY_MS),
    generation,
  })
}

/** 登记链上新链接并在落定后解除未落定登记。解除晚于落定一个微任务：
 * 退出屏障的同步探针因此保守多真一拍，屏障冲刷自身会等链静止，无害。 */
function trackChainSettle(link: Promise<unknown>): void {
  unsettledChains.add(link)
  void link
    .catch(() => undefined)
    .then(() => {
      unsettledChains.delete(link)
    })
}

/** 退出屏障就绪探针（issue #119）：有待重试登记文档或未落定链上动作。 */
export function hasPendingProjectSaves(): boolean {
  return pendingRetryDocs.size > 0 || unsettledChains.size > 0
}

/** 发起所有尚未实际尝试过的登记重存：已发起且未被其他入口取代（登记代次
 * 未变）的跳过；陈旧登记的空操作触发不计入已发起（PR #174 评审）。 */
function fireUnfiredRegistrations(fired: Map<string, number>): void {
  for (const id of Array.from(pendingRetryDocs.keys())) {
    const entry = retryTimers.get(id)
    if (entry === undefined || fired.get(id) === entry.generation) continue
    if (!fireSaveRetry(id)) continue
    // 记录本次发起消费的代次：其自身失败重排为同一代次登记，不重复尝试
    // （不紧循环）；其他入口（编辑器防抖重试/外部保存）失败产生的——即便
    // 携带同一文档对象——新代次登记仍会再试一轮（PR #174 评审）
    fired.set(id, saveGenerations.get(id) ?? 0)
  }
}

/** 仍有未发起过的登记需要再来一轮冲刷：登记代次不等于已发起代次即算
 * （含他入口同文档对象重新登记）。无定时器的登记（其入队保存在途）由链
 * 排空等待落定，不算未发起。 */
function hasUnfiredRegistrations(fired: Map<string, number>): boolean {
  for (const id of pendingRetryDocs.keys()) {
    const entry = retryTimers.get(id)
    if (entry !== undefined && fired.get(id) !== entry.generation) return true
  }
  return false
}

/** 退出冲刷（issue #119）：登记在案的失败重试文档立即重存（不等 5s 后台
 * 节律）并等待全部链上动作落定，仍失败的登记原样保留并返回其项目 id——
 * 退出屏障据此阻断退出并提示。代次已前进的陈旧登记不重放（新保存拥有
 * 终态）；冲刷等待期间新登记的文档也各尝试一次——已发起按登记代次跟踪
 * （文档对象身份不足以区分两个携带同一对象的代次，PR #174 评审）。
 * 不紧循环：冲刷自身发起的保存失败重排为同一代次，不重复尝试；持续失败
 * 交给再次退出与后台节律接管。 */
export async function flushPendingProjectSaves(): Promise<string[]> {
  /** 已实际发起重存的登记：项目 id → 本次发起消费的代次。 */
  const fired = new Map<string, number>()
  for (;;) {
    fireUnfiredRegistrations(fired)
    while (unsettledChains.size > 0) {
      await Promise.allSettled(Array.from(unsettledChains))
    }
    if (!hasUnfiredRegistrations(fired)) break
  }
  return Array.from(pendingRetryDocs.keys())
}

/** 登记文档重存成功监听器：入参为已落盘的登记文档对象（与登记为同一
 * 引用）。 */
export type RetryPersistedListener = (doc: ProjectContent) => void
const retryPersistedListeners = new Set<RetryPersistedListener>()

/** 订阅登记文档经链上重存成功：画布冲刷闸据此清除对应脏态，退出屏障的
 * 定点检查不再对已落盘文档发起冗余重存（PR #174 评审）。返回退订函数。 */
export function onRetryPersisted(listener: RetryPersistedListener): () => void {
  retryPersistedListeners.add(listener)
  return () => retryPersistedListeners.delete(listener)
}

/** 登记文档重存成功的通知口（enqueueSave 落定登记文档时触发；独立导出
 * 供测试注入）。 */
export function notifyRetryPersisted(doc: ProjectContent): void {
  retryPersistedListeners.forEach((listener) => listener(doc))
}

/** 链上写盘动作（Tauri save_project 命令）：入参为会话文档，序列化
 * （剥离会话态）在写入边界执行——归一化/迁移在 model/convert。 */
export async function tauriSave(
  id: string,
  doc: ProjectContent,
  expectExisting = false,
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('save_project', {
    id,
    doc: serializeProject(doc, id),
    expectExisting,
  })
}

/** 保存入队（§3.1 协调入口）：删除墓碑期被吸收留存（删除失败回吐），
 * 否则自增代次排入该项目的串行链；落盘成功清除待重试登记并通知订阅，
 * 失败登记最新文档并按代次调度后台重试（详见模块头）。 */
export function enqueueSave(
  id: string,
  doc: ProjectContent,
  expectExisting = false,
): Promise<void> {
  if (deletingIds.has(id)) {
    if (expectExisting) {
      // 副本后续保存（PR #224 第七轮评审）：墓碑活跃即目标删除在途——
      // 吸收会让 duplicate 对不存在的项目报成功（flag 被墓碑分支丢弃）。
      // 拒绝并抛出：调用方落入清理分支，墓碑解除后目标已被移除
      return Promise.reject(new Error(`项目删除中，拒绝写入副本：${id}`))
    }
    // 吸收但不丢弃：留存最新文档，删除失败时回吐（见 enqueueDelete）
    absorbedSaveDocs.set(id, doc)
    console.warn('[projectStore] 项目删除中，吸收本次保存排队', id)
    return Promise.resolve()
  }
  const generation = (saveGenerations.get(id) ?? 0) + 1
  saveGenerations.set(id, generation)
  const run = (saveChains.get(id) ?? Promise.resolve()).catch(() => undefined)
  const next = run.then(async () => {
    try {
      await tauriSave(id, doc, expectExisting)
      // 任何成功保存都取代并清除既有登记（陈旧登记不得残留）；仅当落盘的
      // 正是登记文档时通知订阅者并记忆落盘文档（画布闸据此清脏、冗余
      // 重写失败据此免登记，PR #174 评审）
      const registered = pendingRetryDocs.get(id)
      if (registered !== undefined) {
        if (registered === doc) {
          retryPersistedDocs.set(id, doc)
          notifyRetryPersisted(doc)
        }
        pendingRetryDocs.delete(id)
      }
      // 落定通知放在失败登记清除之后：此刻磁盘已是本次内容且无待重试文档，
      // 订阅方（首页摘要刷新）据此读到的一定是最终状态（issue #101）
      notifyProjectSaved(id)
    } catch (err) {
      // 同一文档对象已经重试落盘（PR #174 评审）：本次是冗余重写失败，
      // 磁盘已持有该内容——不登记重试、不排定时器，退出屏障不得因此阻断
      if (retryPersistedDocs.get(id) === doc) throw err
      pendingRetryDocs.set(id, doc)
      // 新代次失败接管定时器（scheduleSaveRetry 自清旧登记）：旧代次定时器
      // 留着会在触发时因代次不符自灭，最新登记将无人重试（编辑器已卸载时
      // 即永久丢编辑）
      scheduleSaveRetry(id, generation)
      console.error('[projectStore] 保存失败，已登记后台重试', err)
      throw err
    }
  })
  trackChainSettle(next)
  saveChains.set(id, next)
  return next
}

/** 删除排进同项目保存链：在途保存落定后才发出删除（迟到的保存完成不得
 * 重建 JSON 复活项目）；开场只停摆重试定时器、保留登记文档——登记反映
 * 「最新未落盘的失败保存」，后续保存成功会自行清除它；墓碑先行，删除排队
 * 期间及之后的保存一律吸收。链落定时读取登记（在途保存失败后新登记的、
 * 或开场留存仍未被取代的）并全量清除，随后删除。删除失败（项目仍在磁盘）
 * 时按入队序回吐：先链落定时留存的登记文档、再墓碑期间吸收的最新文档
 * 重新排队保存，最后重排墓碑期间吸收的附属数据写入——不回吐则最新编辑
 * 既没落盘也无重试登记；登记为空即最新保存已成功（或从未失败），不得
 * 回放更早的旧登记（陈旧文档的重试不得覆盖新内容）；删除成功则登记与
 * 吸收的文档、写入随项目一并丢弃。回吐重排的附属写入自身失败时经
 * onProjectWriteReplayFailure 通知订阅者（画布回吐失败自带登记重试，
 * 不需此通道）。 */
export function enqueueDelete(id: string): Promise<void> {
  deletingIds.set(id, (deletingIds.get(id) ?? 0) + 1)
  clearSaveRetryTimer(id)
  const run = (saveChains.get(id) ?? Promise.resolve()).catch(() => undefined)
  let retainedRetryDoc: ProjectContent | undefined
  const next = run.then(async () => {
    // 只认此刻的登记：后续保存成功已把它清除（旧代次作废），回退到开场
    // 捕获值会把被取代的旧文档重放覆盖已落盘的新内容
    retainedRetryDoc = pendingRetryDocs.get(id)
    clearSaveRetry(id)
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('delete_project', { id })
    // 本笔删除已成功：项目在盘上已不存在——同组后续失败的回吐必须丢弃
    // 吸收的写入（重放即复活），标记由墓碑归零统一清除
    deleteSucceededIds.add(id)
  })
  /** 删除失败时的回吐分支：重新登记保留/吸收的快照与附属写入。该链纳入
   * 未落定跟踪（PR #174 评审）：stored 只覆盖删除本身——按微任务续延排序
   * 恢复分支的入队注册恰先于跟踪器移除 stored，屏障实际观测不到空窗；
   * 显式跟踪恢复链后，退出屏障的「unsettled 为空 ⇒ 无待回吐」不变量不再
   * 依赖这一排序。 */
  const recovery = next
    .finally(() => {
      const remaining = (deletingIds.get(id) ?? 1) - 1
      if (remaining <= 0) {
        deletingIds.delete(id)
        deleteSucceededIds.delete(id)
      } else deletingIds.set(id, remaining)
      retryPersistedDocs.delete(id)
    })
    .then(
      () => {
        absorbedSaveDocs.delete(id)
        absorbedProjectWrites.delete(id)
      },
      () => {
        // 墓碑已解除（finally 先行）：回吐的保存走正常排队，不再被吸收
        const retained = retainedRetryDoc
        const absorbed = absorbedSaveDocs.get(id)
        const absorbedWrite = absorbedProjectWrites.get(id)
        absorbedSaveDocs.delete(id)
        absorbedProjectWrites.delete(id)
        // 组级成功（PR #224 第十轮评审）：同组已有一笔删除成功——项目
        // 在盘上已不存在，本笔失败不构成「项目仍在」的信号，重放吸收的
        // 写入只会以 create-if-missing 复活它（保存调用方已按成功处理）
        if (deleteSucceededIds.has(id)) return
        if (retained !== undefined)
          void enqueueSave(id, retained).catch(() => undefined)
        if (absorbed !== undefined)
          void enqueueSave(id, absorbed).catch(() => undefined)
        if (absorbedWrite !== undefined) {
          // 回吐失败无调用方可上浮（原始排队已被吸收为成功）：日志兜底并
          // 通知订阅者转交保留快照（如 AI 会话的 App 级恢复通道）
          void enqueueProjectWrite(id, absorbedWrite).catch((err) => {
            console.error('[projectStore] 回吐重排的附属写入失败', id, err)
            replayFailureListeners.forEach((listener) => listener(id, err))
          })
        }
      },
    )
  trackChainSettle(recovery)
  const stored = next.catch(() => undefined)
  trackChainSettle(stored)
  saveChains.set(id, stored)
  return next
}

/** 等待该项目的保存链静止（§3.1，tauriLoad 内核）：await 后仍是同一
 * Promise 即静止。编辑器卸载后的冲刷可能在途/排队，旧编辑器的防抖还
 * 可能在 A 在途时又补交 B——单次等待只等 A，读盘落在 B 之前会让重开
 * 后的编辑把旧内容重新落盘、反向覆盖 B。 */
export async function waitForSaveChainIdle(id: string): Promise<void> {
  for (;;) {
    const chain = saveChains.get(id)
    if (chain === undefined) return
    await chain.catch(() => undefined)
    if (saveChains.get(id) === chain) return
  }
}

/** 链身份令牌（issue #162 的窄查询口）：返回当前链尾 Promise 作为不透明
 * 身份——调用方只许同值比较（观测窗口内是否有新保存/删除排队），不得
 * await 之外的任何读取（等待静止用 waitForSaveChainIdle）。 */
export function saveChainTokenOf(id: string): Promise<unknown> | undefined {
  return saveChains.get(id)
}

/** 待重试文档的窄查询口（issue #162）：返回当前登记的最新未落盘文档，
 * 无登记返回 undefined。 */
export function pendingRetryDocOf(id: string): ProjectContent | undefined {
  return pendingRetryDocs.get(id)
}

/** 待重试文档的同一性条件替换（issue #162，tauriLoad 复验净载荷回写）：
 * 仅当当前登记仍是要替换的那份（对象同一）才替换为 next 并返回 true——
 * 复验 await 期间登记被更新保存清除/取代时返回 false，调用方按当前保存
 * 状态整体重来，不把已被取代的旧文档复活进登记。 */
export function replacePendingRetryDoc(
  id: string,
  expected: ProjectContent,
  next: ProjectContent,
): boolean {
  if (pendingRetryDocs.get(id) !== expected) return false
  pendingRetryDocs.set(id, next)
  return true
}
