/**
 * 设置页的「编辑即保存」状态族（SettingsView 拆出，§8.2）：防抖 500ms
 * 全量落盘 + 关闭冲刷。在途的 save promise 与未保存快照都会被关闭路径
 * 循环 await，直至没有更新的快照（冲刷期间的新编辑也不例外——编辑器
 * 重挂读到的必是已落盘设置）；落盘失败保留快照并置可见错误、页面保持
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

/** 冲刷所需的在途状态（ref 族）：防抖计时器、未落盘快照、在途 save。 */
interface SaverRefs {
  /** 500ms 防抖计时器：冲刷每轮先清，防止计时器路径绕过 await 落盘。 */
  readonly saveTimer: { current: ReturnType<typeof setTimeout> | null }
  /** 未落盘的最新快照（null = 无待存编辑）。 */
  readonly pendingSaveRef: { current: AppSettings | null }
  /** 防抖已触发、IPC 在途的 save：关闭路径必须等它，不能只看快照。 */
  readonly activeSaveRef: { current: Promise<void> | null }
}

/** 冲刷落盘（S3358 模块级实现）：清防抖 → 循环「await 在途 save → 落盘
 * 未存快照」直至两者皆空。冲刷期间的新编辑同样被 await 后才允许关闭，
 * 不留给 fire-and-forget 兜底——否则编辑器重挂可能读到旧设置、应用退出
 * 可能丢编辑；防抖计时器若在慢 save 期间触发并绕行 persist，下一轮的
 * active await 也会把它收口。 */
async function flushPendingSaves(refs: SaverRefs): Promise<void> {
  const { saveTimer, pendingSaveRef, activeSaveRef } = refs
  if (saveTimer.current) clearTimeout(saveTimer.current)
  for (;;) {
    // 在途 save 的迟到失败不阻断冲刷：失败时其快照已回填 pending（或被
    // 更新的快照取代），由本轮 pending 落盘统一收口重试
    const active = activeSaveRef.current
    if (active !== null) await active.catch(() => {})
    const pending = pendingSaveRef.current
    if (pending === null) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    pendingSaveRef.current = null
    try {
      await settingsStore.save(pending)
    } catch (err) {
      // 冲刷期间用户又编辑过（快照已是更新值）时不回填旧快照
      pendingSaveRef.current ??= pending
      throw err
    }
  }
}

export function useSettingsSaver(
  setSettings: (next: AppSettings) => void,
  onClose: () => void,
): SettingsSaver {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<AppSettings | null>(null)
  const activeSaveRef = useRef<Promise<void> | null>(null)
  const [closing, setClosing] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)

  const persist = useCallback((next: AppSettings): Promise<void> => {
    const p = settingsStore.save(next).catch((err) => {
      // 落盘失败：仅在无更新快照时回填（迟到的旧失败不得覆盖用户随后的
      // 新编辑——否则关闭冲刷会落盘旧快照、静默回退新编辑）
      pendingSaveRef.current ??= next
      throw err
    })
    activeSaveRef.current = p
    void p.catch(() => {}).finally(() => {
      if (activeSaveRef.current === p) activeSaveRef.current = null
    })
    return p
  }, [])

  const update = useCallback(
    (next: AppSettings) => {
      setSettings(next)
      pendingSaveRef.current = next
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        pendingSaveRef.current = null
        void persist(next).catch((err) => console.warn('[SettingsView] 防抖落盘失败', err))
      }, 500)
    },
    [persist, setSettings],
  )

  /** 关闭冲刷：委托 flushPendingSaves（S3358），失败保留现场上抛。 */
  const flush = useCallback(
    (): Promise<void> => flushPendingSaves({ saveTimer, pendingSaveRef, activeSaveRef }),
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
