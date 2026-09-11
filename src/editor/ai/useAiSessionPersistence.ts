/**
 * AI 会话的落盘映射与面板持久化域（issue #47，自 AiThread 拆出）：
 * persistedEntries 把运行中的会话条目映射为可落盘形态（未确认画布落盘的
 * 执行卡降级 pending、剥离运行时标注）并施加落盘条数上限（issue #64）；
 * useAiSessionPersistence 在条目变更时经 onSaveSession 落盘，失败上浮为
 * 面板可见错误（不清空内存历史）。
 */
import { useEffect, useRef, useState } from 'react'
import type { AiSession, ThreadEntry } from './session'

/** 落盘条数上限（issue #64）：自新向旧保留。预览卡的命令与补丁载荷使
 * 单条可能很大，历史无界会让 ai-session.json 与每次全量重写的体积随
 * 对话线性增长。只裁落盘：内存线程不裁（会话内滚动不受影响，喂给模型
 * 的历史另有双界，见 aiThreadModel 的 boundedHistory），加载路径不裁
 * （旧文件全量展示，下次实际变更保存才收敛）——保存是唯一裁剪点。 */
const PERSISTED_ENTRIES_MAX = 200

/** 去掉执行确认的运行时标注（落盘确认与持久化映射共用）：uncommitted 与
 * aiRevisionAfter 都只在等待画布落盘期间有意义。 */
export function stripExecutionRuntime(
  card: NonNullable<ThreadEntry['card']>,
): NonNullable<ThreadEntry['card']> {
  const next = { ...card }
  delete next.uncommitted
  delete next.aiRevisionAfter
  return next
}

/** 去掉回执与卡片的运行时关联标注（不落盘）。 */
function stripReceiptLink(entry: ThreadEntry): ThreadEntry {
  if (entry.cardReceiptFor === undefined) return entry
  const next = { ...entry }
  delete next.cardReceiptFor
  return next
}

/** 条数上限的裁剪（issue #64）：保留最新 PERSISTED_ENTRIES_MAX 条，另把
 * 窗口外仍可执行的待执行卡（pending 且校验通过；含自未确认执行卡降级来
 * 的）钉住保留。待执行卡可长期停留等待确认——用户暂不确认而继续对话不
 * 得使其失去重开后的可执行性（恢复的待执行卡按当前画布重校验，§12.2）；
 * 校验拒绝卡不可执行，只作错误历史，不占钉住名额。钉住条目按原顺序回插
 * 在保留窗口之前，时间线顺序不变；上限语义为「最新 200 条 + 在途待执行卡」，
 * 钉住数量只随用户留存的可执行提案增长。 */
function capPersistedEntries(entries: ThreadEntry[]): ThreadEntry[] {
  if (entries.length <= PERSISTED_ENTRIES_MAX) return entries
  const dropped = entries.slice(0, -PERSISTED_ENTRIES_MAX)
  const pinned = dropped.filter((entry) => entry.card?.status === 'pending' && entry.card.v.ok)
  if (pinned.length === 0) return entries.slice(-PERSISTED_ENTRIES_MAX)
  return [...pinned, ...entries.slice(-PERSISTED_ENTRIES_MAX)]
}

/** 落盘映射：未确认画布落盘的执行卡降级为 pending 并剔除其回执（按关联
 * 而非位置——回执总是追加在会话尾部）——画布若尚未持久化，重开后该卡应
 * 重新可执行，而不是同时声称已执行；保留 aiRevisionAfter 供重开时与画布
 * 批次计数对账。其余条目原样落盘（剥掉运行时关联标注）。映射完成后施加
 * 落盘条数上限（issue #64），窗口外可执行的待执行卡钉住保留，见
 * capPersistedEntries。 */
export function persistedEntries(thread: ThreadEntry[]): ThreadEntry[] {
  const uncommitted = new Set(
    thread.filter((entry) => entry.card?.uncommitted).map((entry) => entry.id),
  )
  const entries: ThreadEntry[] = []
  for (const entry of thread) {
    if (
      entry.kind === 'note' &&
      entry.cardReceiptFor !== undefined &&
      uncommitted.has(entry.cardReceiptFor)
    ) {
      continue
    }
    if (entry.card?.uncommitted) {
      const card = { ...stripExecutionRuntime(entry.card), status: 'pending' as const }
      if (entry.card.aiRevisionAfter !== undefined) card.aiRevisionAfter = entry.card.aiRevisionAfter
      entries.push({ ...stripReceiptLink(entry), card })
      continue
    }
    entries.push(stripReceiptLink(entry))
  }
  return capPersistedEntries(entries)
}

/** 面板会话的「编辑即保存」状态族：条目变更即落盘；保存失败上浮为可见
 * 错误且不清空内存历史。带错误挂载时按 initialSessionRetryable 决定是否
 * 首帧重试——读取失败的空回退会话不可重试（落盘会覆盖可能可恢复的原
 * 文件），须等用户实际变更对话后才随变更保存。项目级错误（App 的
 * aiSessionError）双向同步：非空到达即展示，转空也随之清除——退出重试
 * 保存成功不经面板保存通道，只有项目级清除能把横幅撤下；面板每次保存
 * 都经 App 通道更新项目级状态，双向同步最终一致。 */
export function useAiSessionPersistence(
  thread: ThreadEntry[],
  initialSessionError: string | null | undefined,
  onSaveSession: ((session: AiSession) => Promise<void>) | undefined,
  initialSessionRetryable: boolean | undefined,
): string | null {
  const [saveError, setSaveError] = useState<string | null>(initialSessionError ?? null)
  const hasMounted = useRef(false)
  const retryOnMount = useRef(initialSessionError != null && initialSessionRetryable !== false)
  const saveSessionRef = useRef(onSaveSession)
  useEffect(() => {
    saveSessionRef.current = onSaveSession
  }, [onSaveSession])
  useEffect(() => {
    setSaveError(initialSessionError ?? null)
  }, [initialSessionError])
  useEffect(() => {
    const first = !hasMounted.current
    hasMounted.current = true
    if (first && !retryOnMount.current) return
    const save = saveSessionRef.current
    if (!save) return
    void save({ schemaVersion: 1, entries: persistedEntries(thread) })
      .then(() => setSaveError(null))
      .catch((err: unknown) => setSaveError(String(err)))
  }, [thread])
  return saveError
}
