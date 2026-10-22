/**
 * 设置与 API key 加密的前端门面（docs/ui-design.md §8.2 修订）。
 * 原生宿主经 typed IPC 宿主传输调用各自设置服务（settings.json 落盘；key
 * 在宿主加密后返回密文 envelope，随 provider 配置落盘，明文不回前端）；
 * Swift 持久化成功通知常驻只读消费方重载；内存回退仅限纯
 * 浏览器预览（P2 平台收敛）。
 */
import { defaultSettings, normalizeSettings, type AppSettings } from './types'
import { IPC_COMMANDS } from '../ipc/commands'
import { ipcInvoke } from '../ipc/invoke'
import { isBrowserPreviewHost } from '../platform/hostEnvironment'
import { notifyNativeSettingsChanged } from './nativeSettingsChanges'

/** 浏览器回退的内存设置。 */
let memorySettings: AppSettings | null = null

async function tauriLoad(): Promise<AppSettings> {
  const raw = await ipcInvoke<unknown>(IPC_COMMANDS.loadPrefs)
  return normalizeSettings(raw)
}

async function tauriSave(settings: AppSettings): Promise<void> {
  await ipcInvoke(IPC_COMMANDS.savePrefs, { prefs: settings })
  notifyNativeSettingsChanged()
}

/** 统一门面。 */
export const settingsStore = {
  load: (): Promise<AppSettings> => {
    if (isBrowserPreviewHost()) {
      memorySettings ??= defaultSettings()
      return Promise.resolve(memorySettings)
    }
    // issue #120：读取失败（损坏/权限/超限）向上传播，由调用方展示可
    // 重试错误并阻止以默认值全量覆盖原配置；首次启动由当前宿主仅对
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
   * 加密并保存 provider API key：当前宿主返回密文 envelope，
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
    if (!isBrowserPreviewHost()) {
      keyEnc = await ipcInvoke<string>(IPC_COMMANDS.setProviderKey, {
        providerId,
        key,
      })
    } else {
      keyEnc = `pw1:preview:${btoa(String.fromCodePoint(...new TextEncoder().encode(key)))}`
    }
    return {
      ...settings,
      providers: settings.providers.map((p) =>
        p.id === providerId ? { ...p, keyEnc } : p,
      ),
    }
  },
}
