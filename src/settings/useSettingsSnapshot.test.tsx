// @vitest-environment happy-dom
/**
 * 只读消费方共享设置快照 hook 的测试（PR #175 评审）：StrictMode 双挂载
 * 下两个并发 load 交错完成时，新请求已失败（快照保持 null 的空态承诺）
 * 后，迟到的旧成功不得回填陈旧快照；正常成功路径不受守卫误伤。
 */
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useSettingsSnapshot } from './useSettingsSnapshot'
import { settingsStore } from './settingsStore'
import { defaultSettings, type AppSettings } from './types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useSettingsSnapshot 迟到旧成功守卫（PR #175 评审）', () => {
  it('新请求失败后，迟到的旧成功不得回填陈旧快照', async () => {
    const stale = defaultSettings()
    let resolveOld!: (s: AppSettings) => void
    const loadSpy = vi
      .spyOn(settingsStore, 'load')
      // StrictMode 双挂载：首个 effect 的 load 悬置（模拟延迟 IPC）
      .mockImplementationOnce(
        () => new Promise<AppSettings>((res) => (resolveOld = res)),
      )
      // 第二次挂载的 load 快速失败 → 空选项/引导的失败承诺
      .mockImplementationOnce(() =>
        Promise.reject(new Error('读取设置失败：暂时不可读')),
      )
    const { result } = renderHook(() => useSettingsSnapshot(), {
      wrapper: StrictMode,
    })
    await waitFor(() => expect(loadSpy).toHaveBeenCalledTimes(2))
    await act(async () => {
      await Promise.resolve() // 冲刷新请求的拒绝
    })
    expect(result.current).toBeNull()

    await act(async () => {
      resolveOld(stale) // 旧请求此刻才成功（携带双挂载早期的快照）
      await Promise.resolve()
    })
    expect(result.current).toBeNull() // 不得回填陈旧快照重新启用面板
    loadSpy.mockRestore()
  })

  it('正常成功路径仍更新快照（守卫不误伤）', async () => {
    const loaded = defaultSettings()
    vi.spyOn(settingsStore, 'load').mockResolvedValue(loaded)
    const { result } = renderHook(() => useSettingsSnapshot(), {
      wrapper: StrictMode,
    })
    await waitFor(() => expect(result.current).toEqual(loaded))
  })
})
