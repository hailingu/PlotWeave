/**
 * §3.1 项目级保存链与删除墓碑（issue #39 自 projectStore.ts 拆出）：保存按
 * 项目串行（后保存者的内容永不早于先保存者落盘）；失败把最新文档登记为
 * 待重试并按固定节律后台重试——编辑器卸载/导航后组件不复存在，最新文档
 * 只存在于这里，瞬时故障（磁盘满/权限）不得永久丢编辑。重试绑定**保存
 * 代次**：每次入队自增，新保存一排队旧代次重试即作废——陈旧文档的重试
 * 不得后完成覆盖新内容。删除同样排进链：在途保存落定后才删，且先取消
 * 全部重试登记，已删项目不得被迟到的完成/重试复活。
 */
import { serializeProject } from '../model/convert'
import type { ProjectContent } from '../model/content'

const SAVE_RETRY_DELAY_MS = 5000
export const saveChains = new Map<string, Promise<unknown>>()
export const pendingRetryDocs = new Map<string, ProjectContent>()
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const saveGenerations = new Map<string, number>()
/** 删除墓碑：删除开始即立——之后为该项目排队的任何保存被吸收，迟到的
 * 合并冲刷/重试不得重建 JSON 复活用户刚删的项目；删除落定（成功或失败）
 * 后清除，失败时项目仍在、可继续保存。 */
const deletingIds = new Set<string>()
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
export type ProjectWriteReplayFailureListener = (id: string, err: unknown) => void
const replayFailureListeners = new Set<ProjectWriteReplayFailureListener>()

/** 订阅删除失败后回吐重排的附属写入失败；返回退订函数。 */
export function onProjectWriteReplayFailure(
  listener: ProjectWriteReplayFailureListener,
): () => void {
  replayFailureListeners.add(listener)
  return () => replayFailureListeners.delete(listener)
}

/** 将项目附属数据的写入纳入与画布相同的保存/删除链。删除墓碑期的写入
 * 被吸收（登记最新闭包，删除失败时回吐），保证已删除项目不会因迟到的
 * 独立持久化操作重建目录。 */
export function enqueueProjectWrite(id: string, write: () => Promise<void>): Promise<void> {
  if (deletingIds.has(id)) {
    // 吸收但不丢弃：留存最新写入闭包，删除失败时回吐（见 enqueueDelete）
    absorbedProjectWrites.set(id, write)
    console.warn('[projectStore] 项目删除中，吸收附属数据写入', id)
    return Promise.resolve()
  }
  const run = (saveChains.get(id) ?? Promise.resolve()).catch(() => undefined)
  const next = run.then(write)
  saveChains.set(id, next)
  return next
}

/** 取消后台重试定时器（不触碰登记文档）：删除开场只需停摆定时器——墓碑
 * 期定时器即使触发也只会被 enqueueSave 吸收（不会复活已删项目），但停摆
 * 更干净；登记文档留待链落定处的全量清除与回吐判定。 */
function clearSaveRetryTimer(id: string): void {
  const timer = retryTimers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    retryTimers.delete(id)
  }
}

function clearSaveRetry(id: string): void {
  clearSaveRetryTimer(id)
  pendingRetryDocs.delete(id)
}

function scheduleSaveRetry(id: string, generation: number): void {
  retryTimers.set(
    id,
    setTimeout(() => {
      retryTimers.delete(id)
      // 代次已前进（有更新的保存排队/完成）：本次登记作废，由新代次自洽
      if (saveGenerations.get(id) !== generation) return
      const doc = pendingRetryDocs.get(id)
      if (doc !== undefined) void enqueueSave(id, doc).catch(() => undefined)
    }, SAVE_RETRY_DELAY_MS),
  )
}

/** 链上写盘动作（Tauri save_project 命令）：入参为会话文档，序列化
 * （剥离会话态）在写入边界执行——归一化/迁移在 model/convert。 */
export async function tauriSave(id: string, doc: ProjectContent): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('save_project', { id, doc: serializeProject(doc, id) })
}

export function enqueueSave(id: string, doc: ProjectContent): Promise<void> {
  if (deletingIds.has(id)) {
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
      await tauriSave(id, doc)
      pendingRetryDocs.delete(id)
    } catch (err) {
      pendingRetryDocs.set(id, doc)
      // 新代次失败接管定时器：旧代次定时器留着会在触发时因代次不符自灭，
      // 最新登记将无人重试（编辑器已卸载时即永久丢编辑）
      const stale = retryTimers.get(id)
      if (stale !== undefined) {
        clearTimeout(stale)
        retryTimers.delete(id)
      }
      scheduleSaveRetry(id, generation)
      console.error('[projectStore] 保存失败，已登记后台重试', err)
      throw err
    }
  })
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
  deletingIds.add(id)
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
  })
  next
    .finally(() => {
      deletingIds.delete(id)
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
        if (retained !== undefined) void enqueueSave(id, retained).catch(() => undefined)
        if (absorbed !== undefined) void enqueueSave(id, absorbed).catch(() => undefined)
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
    .catch(() => undefined)
  saveChains.set(id, next.catch(() => undefined))
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
