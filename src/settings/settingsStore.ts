/**
 * 设置与 API key 加密的前端门面（docs/ui-design.md §8.2 修订）。
 * 原生宿主经 src/platform 命令传输走 Rust 命令（settings.json 落盘；key
 * 由 Rust 加密后返回密文 envelope，随 provider 配置落盘，明文不回前端；
 * Swift 宿主传输待 P2 后续接通，未接通时可见失败）；内存回退仅限纯
 * 浏览器预览（P2 平台收敛）。
 */
import { defaultSettings, normalizeSettings, type AppSettings } from './types'
import { isBrowserPreviewHost } from '../platform/hostEnvironment'
import { hostInvoke } from '../platform/hostCommands'

/** 浏览器回退的内存设置。 */
let memorySettings: AppSettings | null = null

async function tauriLoad(): Promise<AppSettings> {
  const raw = await hostInvoke<unknown>('load_prefs')
  return normalizeSettings(raw)
}

async function tauriSave(settings: AppSettings): Promise<void> {
  await hostInvoke('save_prefs', { prefs: settings })
}

/** 统一门面。 */
export const settingsStore = {
  load: (): Promise<AppSettings> => {
    if (isBrowserPreviewHost()) {
      memorySettings ??= defaultSettings()
      return Promise.resolve(memorySettings)
    }
    // issue #120：读取失败（损坏/权限/超限）向上传播，由调用方展示可
    // 重试错误并阻止以默认值全量覆盖原配置；首次启动由 Rust 侧仅对
    // 文件缺失返回空对象，经 normalizeSettings 补内置默认。
    return tauriLoad()
  },

  save: (settings: AppSettings): Promise<void> => {
    if (isBrowserPreviewHost()) {
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
    if (isBrowserPreviewHost()) {
      keyEnc = `pw1:preview:${btoa(String.fromCodePoint(...new TextEncoder().encode(key)))}`
    } else {
      keyEnc = await hostInvoke<string>('set_provider_key', {
        providerId,
        key,
      })
    }
    return {
      ...settings,
      providers: settings.providers.map((p) =>
        p.id === providerId ? { ...p, keyEnc } : p,
      ),
    }
  },
}
