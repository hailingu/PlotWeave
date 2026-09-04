/**
 * 设置页的「编辑即保存」状态族（SettingsView 拆出，§8.2）：防抖 500ms
 * 全量落盘 + 关闭冲刷。所有 save 经单一串行队列按提交顺序执行——杜绝
 * 乱序完成或迟到失败把磁盘回退到旧快照；关闭路径循环等待「队列排空且
 * 无待存快照」（冲刷期间的新编辑也不例外——编辑器重挂读到的必是已落盘
 * 设置）。落盘失败仅当无更新快照提交时回填待存并置可见错误、页面保持
 * 打开可重试——不静默丢失编辑。卸载路径为 fire-and-forget 兜底（非常规
 * 关闭不丢编辑）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings } from './types'
import { settingsStore } from './settingsStore'

/** useSettingsSaver 的返回：编辑写入、关闭处理、可见错误与关态。 */
export interface SettingsSaver {
  /** 编辑即保存：更新组件状态 + 登记 500ms 防抖落盘。 */
  update: (next: AppSettings) => void
  /** 「完成」：await 在途/未保存落盘（含冲刷期间的新编辑）；失败置 closeError 并保持打开。 */
  handleClose: () => void
  /** 关闭冲刷失败的可见可重试错误（null = 无）。 */
  closeError: string | null
  /** 关闭冲刷进行中（按钮「保存中…」防双击）。 */
  closing: boolean
}

/** 冲刷/落盘所需的在途状态（ref 族）。 */
interface SaverRefs {
  /** 500ms 防抖计时器：冲刷每轮先清，防止计时器路径绕过 await 落盘。 */
  readonly saveTimer: { current: ReturnType<typeof setTimeout> | null }
  /** 未落盘的最新快照（null = 无待存编辑）。 */
  readonly pendingSaveRef: { current: AppSettings | null }
  /** 串行落盘队列队尾（永不 reject；null = 空闲）：所有 save 按提交
   * 顺序执行，杜绝「新快照已落盘、旧 save 乱序迟到」把磁盘回退。 */
  readonly saveChainRef: { current: Promise<void> | null }
  /** 已提交 save 的最新序号：失败回填只对最新提交的快照生效。 */
  readonly revRef: { current: number }
}

/** 提交一次全量落盘到串行队列（S3358 模块级实现）：空闲时立即发起，
 * 否则排在队尾之后。失败仅当「无更新快照已提交（rev 最新）且无待存
 * 编辑」时回填重试——更新快照已入队（将落盘）或已落盘时回填旧值，
 * 会让后续冲刷把磁盘回退到旧设置。 */
function enqueueSave(refs: SaverRefs, next: AppSettings): Promise<void> {
  const rev = ++refs.revRef.current
  const prev = refs.saveChainRef.current
  const run =
    prev === null ? settingsStore.save(next) : prev.then(() => settingsStore.save(next))
  const tail = run.catch(() => {})
  refs.saveChainRef.current = tail
  void tail.finally(() => {
    if (refs.saveChainRef.current === tail) refs.saveChainRef.current = null
  })
  void run.catch(() => {
    if (rev === refs.revRef.current) refs.pendingSaveRef.current ??= next
  })
  return run
}

/** 冲刷落盘（S3358 模块级实现）：清防抖 → 循环「等队尾 → 落盘未存快照」
 * 直至队列空闲且无待存快照；等待期间新提交的 save（如防抖计时器触发的
 * 落盘）会移动队尾，下一轮继续收口——close 不得早于任何一次已提交的
 * 落盘完成。失败回填由 enqueueSave 的 rev 守卫统一处理，此处仅上抛。 */
async function flushPendingSaves(refs: SaverRefs): Promise<void> {
  const { saveTimer, pendingSaveRef, saveChainRef } = refs
  if (saveTimer.current) clearTimeout(saveTimer.current)
  for (;;) {
    const tail = saveChainRef.current
    if (tail !== null) {
      await tail.catch(() => {})
      if (saveChainRef.current !== null) continue // 等待期间有新提交：再收口
    }
    const pending = pendingSaveRef.current
    if (pending === null) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    pendingSaveRef.current = null
    await enqueueSave(refs, pending)
  }
}

export function useSettingsSaver(
  setSettings: (next: AppSettings) => void,
  onClose: () => void,
): SettingsSaver {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<AppSettings | null>(null)
  const saveChainRef = useRef<Promise<void> | null>(null)
  const revRef = useRef(0)
  const [closing, setClosing] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)

  const update = useCallback(
    (next: AppSettings) => {
      setSettings(next)
      pendingSaveRef.current = next
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        pendingSaveRef.current = null
        enqueueSave({ saveTimer, pendingSaveRef, saveChainRef, revRef }, next).catch(
          (err) => console.warn('[SettingsView] 防抖落盘失败', err),
        )
      }, 500)
    },
    [setSettings],
  )

  /** 关闭冲刷：委托 flushPendingSaves（S3358），失败保留现场上抛。 */
  const flush = useCallback(
    (): Promise<void> => flushPendingSaves({ saveTimer, pendingSaveRef, saveChainRef, revRef }),
    [],
  )

  const handleClose = useCallback((): void => {
    if (closing) return
    setClosing(true)
    flush()
      .then(() => {
        setCloseError(null)
        onClose()
      })
      .catch((err) => {
        setCloseError(`保存设置失败：${err instanceof Error ? err.message : String(err)}——请重试关闭`)
        setClosing(false)
      })
  }, [closing, flush, onClose])

  // 卸载兜底（非常规关闭）：flush 只经 ref 读写，首帧闭包行为不变
  useEffect(() => {
    return () => {
      void flush().catch((err) => console.warn('[SettingsView] 卸载冲刷保存失败', err))
    }
  }, [flush])

  return { update, handleClose, closeError, closing }
}
