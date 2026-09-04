/**
 * 设置页的「编辑即保存」状态族（SettingsView 拆出，§8.2）：防抖 500ms
 * 全量落盘 + 关闭冲刷。在途的 save promise 与未保存快照都会被关闭路径
 * await（编辑器重挂读到的必是已落盘设置）；落盘失败保留快照并置可见
 * 错误、页面保持打开可重试——不静默丢失编辑。卸载路径为 fire-and-forget
 * 兜底（非常规关闭不丢编辑）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings } from './types'
import { settingsStore } from './settingsStore'

/** useSettingsSaver 的返回：编辑写入、关闭处理、可见错误与关态。 */
export interface SettingsSaver {
  /** 编辑即保存：更新组件状态 + 登记 500ms 防抖落盘。 */
  update: (next: AppSettings) => void
  /** 「完成」：await 在途/未保存落盘；失败置 closeError 并保持打开。 */
  handleClose: () => void
  /** 关闭冲刷失败的可见可重试错误（null = 无）。 */
  closeError: string | null
  /** 关闭冲刷进行中（按钮「保存中…」防双击）。 */
  closing: boolean
}

export function useSettingsSaver(
  setSettings: (next: AppSettings) => void,
  onClose: () => void,
): SettingsSaver {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<AppSettings | null>(null)
  /** 防抖已触发、IPC 在途的 save：关闭路径必须等它，不能只看快照。 */
  const activeSaveRef = useRef<Promise<void> | null>(null)
  const [closing, setClosing] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)

  const persist = useCallback((next: AppSettings): Promise<void> => {
    const p = settingsStore.save(next).catch((err) => {
      // 落盘失败：快照保留供关闭冲刷重试；上抛供在途等待方感知
      pendingSaveRef.current = next
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

  /** 关闭冲刷：清防抖 → await 在途 save → 落盘未保存快照；失败保留现场上抛。 */
  const flush = useCallback(async (): Promise<void> => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    await activeSaveRef.current
    const pending = pendingSaveRef.current
    if (pending !== null) {
      pendingSaveRef.current = null
      try {
        await settingsStore.save(pending)
      } catch (err) {
        pendingSaveRef.current = pending
        throw err
      }
    }
  }, [])

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
