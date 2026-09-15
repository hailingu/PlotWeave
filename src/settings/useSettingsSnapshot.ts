/**
 * 只读消费方共享的设置快照加载 hook（PR #175 评审拆出）：挂载时读一次
 * 设置，成功才更新快照；失败仅告警并保持 null——消费方（AI 面板、图片
 * 节点表单）据此走空选项/引导态，只读不落盘（issue #120）。面板每次
 * 重挂（切分段回来）随之重载。完成按代际守卫（PR #175 评审）：
 * StrictMode 双挂载的并发 load 交错完成时，仅最新请求可写快照——
 * 新请求已失败时，迟到的旧成功不得回填陈旧快照重新启用面板。
 */
import { useEffect, useRef, useState } from 'react'
import { settingsStore } from './settingsStore'
import type { AppSettings } from './types'

/** 当前设置快照；null = 未加载或加载失败（消费方按空态处理）。 */
export function useSettingsSnapshot(): AppSettings | null {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  /** load 代际：effect 每跑一次自增，旧代完成即丢弃。 */
  const genRef = useRef(0)
  useEffect(() => {
    const gen = ++genRef.current
    void settingsStore.load().then(
      (s) => {
        if (gen === genRef.current) setSettings(s)
      },
      (err: unknown) => {
        if (gen === genRef.current)
          console.warn('[settingsSnapshot] 读取设置失败', err)
      },
    )
  }, [])
  return settings
}
