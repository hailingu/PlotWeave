/**
 * 设置与 API key 加密的前端门面（docs/ui-design.md §8.2 修订）。
 * Tauri 环境走 Rust 命令（settings.json 落盘；key 由 Rust 加密后
 * 返回密文 envelope，随 provider 配置落盘，明文不回前端）；
 * 浏览器预览回退内存实现。
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

  /**
   * 加密并保存 provider API key：Rust 返回密文 envelope，
   * 合并进 provider 配置后返回**新的 settings**（由调用方走
   * 防抖落盘）；key 明文不回前端、不进钥匙串。
   * 浏览器预览仅内存态（base64 标记 preview:，不落盘）。
   */
  setProviderKey: async (
    settings: AppSettings,
    providerId: string,
    key: string,
  ): Promise<AppSettings> => {
    let keyEnc: string
    if (isTauri) {
      const { invoke } = await import('@tauri-apps/api/core')
      keyEnc = await invoke<string>('set_provider_key', { providerId, key })
    } else {
      keyEnc = `pw1:preview:${btoa(String.fromCharCode(...new TextEncoder().encode(key)))}`
    }
    return {
      ...settings,
      providers: settings.providers.map((p) =>
        p.id === providerId ? { ...p, keyEnc } : p,
      ),
    }
  },
}
