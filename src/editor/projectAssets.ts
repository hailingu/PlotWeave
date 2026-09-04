/**
 * 项目资产门面（数据模型 §7.1/§7.3/§9.3）。
 * Tauri 环境走 Rust 命令：导入 = 库文件拷贝进项目 assets/（句柄链
 * no-follow 落盘）并生成项目级 AssetRef，入会话索引前再过
 * validate_project_asset 预检（§9.3 set_asset 强制）；媒体 URL 经
 * project_asset_path 实路径复验后 convertFileSrc 拼接。
 * 浏览器预览无 IPC，回退为内存实现：导入生成假规范 relPath 的 AssetRef
 *（归一化往返可存活），同时经源 blob 建独立 object URL 挂到项目资产 id
 *（拷贝语义：源库资产删除不影响项目缩略图；重载后映射丢失即拒绝，
 * 预览不落盘，属预期）。
 */
import type { AssetRef } from '../model/document'
import { libraryStore } from '../library/libraryStore'
import { uid } from '../uid'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** 内存回退：项目资产 id → 导入时建立的独立 object URL（URL store 钉住
 * 源 blob，脱离库内条目存活；会话内有效，重载即失效）。 */
const memoryUrls = new Map<string, string>()

interface RawAssetRef {
  id?: unknown
  relPath?: unknown
  mime?: unknown
  source?: unknown
  createdAt?: unknown
}

/** IPC 返回条目的边界校验 + 规范化（mime trim/小写）：坏数据不进会话索引。
 * 导出供生成产物并入索引时共用（llm_image_generate 返回值同域，§9.3）。 */
export function normalizeAssetRef(raw: RawAssetRef | null): AssetRef {
  if (
    raw === null ||
    typeof raw !== 'object' ||
    typeof raw.id !== 'string' ||
    raw.id === '' ||
    typeof raw.relPath !== 'string' ||
    !raw.relPath.startsWith('assets/') ||
    typeof raw.mime !== 'string' ||
    (raw.source !== 'upload' && raw.source !== 'generated') ||
    typeof raw.createdAt !== 'string'
  ) {
    throw new Error('命令返回了无效资产条目')
  }
  return {
    id: raw.id,
    relPath: raw.relPath,
    mime: raw.mime.trim().toLowerCase(),
    source: raw.source,
    createdAt: raw.createdAt,
  }
}

/** mime → 扩展名回退（内存路径的文件名后缀；与 Rust ext_for 同族）。 */
function extFromNameOrMime(name: string, mime: string): string {
  const dot = name.lastIndexOf('.')
  if (dot >= 0) {
    const ext = name.slice(dot + 1).toLowerCase()
    if (ext !== '' && ext.length <= 8 && /^[a-z0-9]+$/.test(ext)) return ext
  }
  const byMime: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
  }
  return byMime[mime] ?? 'bin'
}

async function tauriImport(projectId: string, libraryAssetId: string): Promise<AssetRef> {
  const { invoke } = await import('@tauri-apps/api/core')
  const imported = normalizeAssetRef(
    await invoke<RawAssetRef>('import_project_asset_from_library', {
      id: projectId,
      libraryAssetId,
    }),
  )
  // §9.3：入索引前过 Rust 预检，使用预检返回的规范化条目
  return normalizeAssetRef(
    await invoke<RawAssetRef>('validate_project_asset', { id: projectId, asset: imported }),
  )
}

// 浏览器预览无项目目录：projectId 仅保持与 Tauri 路径接口同形，不参与逻辑
async function memoryImport(_projectId: string, libraryAssetId: string): Promise<AssetRef> {
  const list = await libraryStore.list()
  const lib = list.find((a) => a.id === libraryAssetId)
  if (!lib) throw new Error(`库资产不存在：${libraryAssetId}`)
  const id = uid('pa')
  const asset: AssetRef = {
    id,
    relPath: `assets/${id}.${extFromNameOrMime(lib.name, lib.mime)}`,
    mime: lib.mime.trim().toLowerCase() || 'application/octet-stream',
    source: 'upload',
    createdAt: new Date().toISOString(),
  }
  // 拷贝语义（§7.3）：导入即经源 blob 建独立 object URL，源取不到则导入失败
  memoryUrls.set(id, await libraryStore.mediaUrl({ id: lib.id, relPath: '' }))
  return asset
}

async function tauriMediaUrl(projectId: string, asset: AssetRef): Promise<string> {
  const { invoke, convertFileSrc } = await import('@tauri-apps/api/core')
  const abs = await invoke<string>('project_asset_path', { id: projectId, relPath: asset.relPath })
  return convertFileSrc(abs)
}

/** IPC 直调助手（仅桌面端；动态导入避免浏览器预览加载 Tauri 模块）：
 * 生成命令等新增 Rust 管线的复用入口。 */
export function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  return (async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<T>(cmd, args)
  })()
}

/** 统一门面：两种环境同签名。 */
export const projectAssets = {
  /** 库资产拷贝进项目（§7.3）：返回项目级 AssetRef（新 id）。 */
  importFromLibrary: (projectId: string, libraryAssetId: string): Promise<AssetRef> =>
    isTauri ? tauriImport(projectId, libraryAssetId) : memoryImport(projectId, libraryAssetId),

  /** 媒体 URL：Tauri 走 asset 协议（实路径复验后拼接）；内存回退返回
   * 导入时建立的独立 object URL（源库删除不影响）——重载后映射丢失即
   * 拒绝（预览不落盘，属预期）。 */
  mediaUrl: (projectId: string, asset: AssetRef): Promise<string> => {
    if (isTauri) return tauriMediaUrl(projectId, asset)
    const url = memoryUrls.get(asset.id)
    if (!url) {
      return Promise.reject(new Error(`资产 ${asset.id} 的媒体不在本会话内存中（浏览器预览不落盘）`))
    }
    return Promise.resolve(url)
  },

  /** 复验既有项目资产的落盘状态（§9.3 实路径复验同域）：撤销后重做的
   * 防线（issue #10）——撤销窗口内文件被外部删改则拒绝，避免失效条目
   * 重做入脏、save_project 全量拒绝卡死自动保存。Tauri 走 Rust
   * validate_project_asset；浏览器预览内存态无盘上文件，恒通过。 */
  revalidate: (projectId: string, asset: AssetRef): Promise<void> => {
    if (!isTauri) return Promise.resolve()
    return tauriInvoke<RawAssetRef>('validate_project_asset', { id: projectId, asset }).then(
      (raw) => {
        normalizeAssetRef(raw)
      },
    )
  },
}
