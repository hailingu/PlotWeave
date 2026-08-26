/**
 * 设置与钥匙串的前端门面（docs/ui-design.md §8.2）。
 * Tauri 环境走 Rust 命令（settings.json 落盘 + 系统钥匙串）；
 * 浏览器预览回退内存实现（key 状态不可用，仅保 UI 可预览）。
 */
import {
  defaultSettings,
  normalizeSettings,
  type AppSettings,
} from './types'

const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** 浏览器回退的内存设置。 */
let memorySettings: AppSettings | null = null

async function tauriLoad(): Promise<AppSettings> {
  const { invoke } = await import('@tauri-apps/api/core')
  const raw = await invoke<unknown>('load_prefs')
  return normalizeSettings(raw)
}

async function tauriSave(settings: AppSettings): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('save_prefs', { prefs: settings })
}

/** 统一门面。 */
export const settingsStore = {
  load: (): Promise<AppSettings> => {
    if (!isTauri) {
      memorySettings ??= defaultSettings()
      return Promise.resolve(memorySettings)
    }
    return tauriLoad().catch((err) => {
      console.warn('[settingsStore] 读取设置失败', err)
      return defaultSettings()
    })
  },

  save: (settings: AppSettings): Promise<void> => {
    if (!isTauri) {
      memorySettings = settings
      return Promise.resolve()
    }
    return tauriSave(settings)
  },

  /** 写入 provider API key（钥匙串；浏览器预览不可用）。 */
  setProviderKey: (providerId: string, key: string): Promise<void> => {
    if (!isTauri) {
      return Promise.reject(new Error('浏览器预览无法访问钥匙串'))
    }
    return import('@tauri-apps/api/core').then(({ invoke }) =>
      invoke('set_provider_key', { providerId, key }),
    )
  },

  clearProviderKey: (providerId: string): Promise<void> => {
    if (!isTauri) return Promise.resolve()
    return import('@tauri-apps/api/core').then(({ invoke }) =>
      invoke('clear_provider_key', { providerId }),
    )
  },

  /** 查询 key 是否已配置（不回传明文，§8.2）。 */
  hasProviderKey: (providerId: string): Promise<boolean> => {
    if (!isTauri) return Promise.resolve(false)
    return import('@tauri-apps/api/core').then(({ invoke }) =>
      invoke<boolean>('has_provider_key', { providerId }),
    )
  },
}
