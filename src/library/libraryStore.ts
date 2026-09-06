/** 个人资产库前端门面（docs/ui-design.md §8.1 / 数据模型 §7）。
 * Tauri 环境走 Rust 命令（应用级 library/ 目录，媒体经 pwmedia 自定义
 * 协议按 assetId 懒加载——§7.1 opaque asset URL，relPath 与本机绝对路径
 * 不进入前端媒体链路，issue #26）；
 * 浏览器预览无 IPC，回退为同接口的内存实现（Blob object URL）。
 * 跨项目复用：库是应用级作用域，与项目内资产互不引用（§7.3 流转
 * 「拖上画布 = 拷贝进项目」由 src/editor/projectAssets.ts 承接）。
 */

import { uid } from '../uid'

export type LibraryKind =
  | 'character'
  | 'location'
  | 'wardrobe'
  | 'colorlight'
  | 'reference'
  | 'other'

export const LIBRARY_KINDS: Array<{ kind: LibraryKind; label: string; icon: string }> = [
  { kind: 'character', label: '角色设定', icon: '🎭' },
  { kind: 'location', label: '场景设定', icon: '🏔' },
  { kind: 'wardrobe', label: '服化道', icon: '🧥' },
  { kind: 'colorlight', label: '色彩光影', icon: '🎨' },
  { kind: 'reference', label: '风格参考', icon: '🖼' },
  { kind: 'other', label: '其他', icon: '📦' },
]

const KIND_SET = new Set(LIBRARY_KINDS.map((k) => k.kind as string))

/** 库资产条目（library.json 索引项的运行态形态）。 */
export interface LibraryAsset {
  id: string
  name: string
  kind: LibraryKind
  /** 视角（front/side/…/expression/turnout），未标注为 null。 */
  view: string | null
  mime: string
  /** 相对 library 目录的媒体路径。 */
  relPath: string
  tags: string[]
  groupId: string | null
  createdAt: number
  /** 删除事务冲突期标记（§7.2）：媒体打开/导入拒绝服务（issue #25）。 */
  conflicted?: boolean
}

interface RawAsset {
  id?: unknown
  name?: unknown
  kind?: unknown
  view?: unknown
  mime?: unknown
  relPath?: unknown
  tags?: unknown
  groupId?: unknown
  createdAt?: unknown
  conflicted?: unknown
}

function normalizeAsset(raw: RawAsset | null): LibraryAsset | null {
  // IPC 信任边界：非对象载荷（含 null）整条丢弃，不向上抛 TypeError
  if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '') {
    return null
  }
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : '未命名资产',
    kind: typeof raw.kind === 'string' && KIND_SET.has(raw.kind) ? (raw.kind as LibraryKind) : 'other',
    view: typeof raw.view === 'string' ? raw.view : null,
    mime: typeof raw.mime === 'string' ? raw.mime : 'application/octet-stream',
    relPath: typeof raw.relPath === 'string' ? raw.relPath : '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
    groupId: typeof raw.groupId === 'string' ? raw.groupId : null,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    // 冲突期标记原样保留（原 relPath 可能已绑定后来文件，媒体/导入拒服务）
    conflicted: raw.conflicted === true ? true : undefined,
  }
}

const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** 后端隔离/修复诊断统一进既有 console.warn 路径（issue #17）：list 与
 * 各变更命令的 warnings 清单逐条上报，被隔离条目不得静默消失或被
 * "落盘即净化"静默改写。 */
function reportLibraryWarnings(warnings: unknown): void {
  if (Array.isArray(warnings)) {
    for (const w of warnings) {
      if (typeof w === 'string' && w !== '') console.warn('[Library] 索引条目隔离：', w)
    }
  }
}

/** 内存回退：blob + object URL，会话内有效。 */
const memoryAssets = new Map<string, { asset: LibraryAsset; blob: Blob }>()

async function tauriList(): Promise<LibraryAsset[]> {
  const { invoke } = await import('@tauri-apps/api/core')
  const index = await invoke<{
    assets?: { byId?: Record<string, unknown> }
    warnings?: unknown[]
    cleanupPending?: unknown[]
  }>('library_list')
  reportLibraryWarnings(index.warnings)
  // 隔离区积压（身份绑定清理不可用）：随列表上报为诊断，不再静默累积
  if (Array.isArray(index.cleanupPending) && index.cleanupPending.length > 0) {
    console.warn('[Library] 删除隔离区待清理：', index.cleanupPending)
  }
  // §7.2 Record 形状：assets.byId 的值即条目（issue #29 PR 1，评审修复——
  // 旧数组形状已迁移，前端必须按 byId 读取，否则全部资产被隐藏）
  const byId = index.assets?.byId
  const entries = byId && typeof byId === 'object' ? Object.values(byId) : []
  return entries
    .map((a) => normalizeAsset(a as RawAsset))
    .filter((a): a is LibraryAsset => a !== null)
}

async function tauriPut(file: File, kind: LibraryKind): Promise<LibraryAsset> {
  const { invoke } = await import('@tauri-apps/api/core')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const entry = await invoke<RawAsset>('library_put', {
    name: file.name,
    mime: file.type || 'application/octet-stream',
    kind,
    bytes: Array.from(bytes),
  })
  reportLibraryWarnings((entry as { warnings?: unknown } | null)?.warnings)
  const normalized = normalizeAsset(entry)
  if (!normalized) throw new Error('导入返回了无效条目')
  return normalized
}

/** 媒体 opaque URL（§7.1，issue #26）：只传逻辑 scope + assetId，由 Rust
 * 按当前索引解析并返回 `pwmedia://` URL——relPath 与本机绝对路径不出
 * Rust，前端不再拼接。冲突期条目本地快路径先行拦截（issue #25）。 */
async function tauriMediaUrl(asset: Pick<LibraryAsset, 'id' | 'conflicted'>): Promise<string> {
  if (asset.conflicted) throw new Error('资产处于删除事务冲突期，媒体不可用')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string>('get_asset_media_url', {
    scope: { kind: 'library' },
    assetId: asset.id,
  })
}

/** 统一门面：两种环境同签名。 */
export const libraryStore = {
  list: (): Promise<LibraryAsset[]> =>
    isTauri ? tauriList() : Promise.resolve([...memoryAssets.values()].map((v) => v.asset)),

  put: (file: File, kind: LibraryKind): Promise<LibraryAsset> => {
    if (isTauri) return tauriPut(file, kind)
    const id = uid('local-la')
    const asset: LibraryAsset = {
      id,
      name: file.name,
      kind,
      view: null,
      mime: file.type || 'application/octet-stream',
      relPath: '',
      tags: [],
      groupId: null,
      createdAt: Date.now(),
    }
    memoryAssets.set(id, { asset, blob: file })
    return Promise.resolve(asset)
  },

  updateMeta: (id: string, patch: Partial<Pick<LibraryAsset, 'name' | 'tags' | 'groupId' | 'view'>>): Promise<LibraryAsset> => {
    if (isTauri) {
      return import('@tauri-apps/api/core').then(async ({ invoke }) => {
        const entry = await invoke<RawAsset>('library_update_meta', { id, patch })
        reportLibraryWarnings((entry as { warnings?: unknown } | null)?.warnings)
        const normalized = normalizeAsset(entry)
        if (!normalized) throw new Error('更新返回了无效条目')
        return normalized
      })
    }
    const hit = memoryAssets.get(id)
    if (!hit) return Promise.reject(new Error(`资产不存在：${id}`))
    hit.asset = { ...hit.asset, ...patch }
    memoryAssets.set(id, hit)
    return Promise.resolve(hit.asset)
  },

  remove: (id: string): Promise<void> => {
    if (isTauri) {
      return import('@tauri-apps/api/core').then(async ({ invoke }) => {
        const result = await invoke<{ warnings?: unknown; cleanupPending?: unknown[] }>('library_delete', { id })
        reportLibraryWarnings(result?.warnings)
        // 隔离区积压随删除响应上报（评审修复：删除成功后不再静默累积）
        if (result?.cleanupPending?.length) {
          console.warn('[Library] 删除隔离区待清理：', result.cleanupPending)
        }
      })
    }
    memoryAssets.delete(id)
    return Promise.resolve()
  },

  /** 媒体 URL：Tauri 走 pwmedia 自定义协议（opaque URL，Rust 侧逐请求
   * 解析 id）；内存回退为 object URL。
   * 入参只需 id/conflicted 子集：项目资产导入拷贝（projectAssets）按来源
   * 库资产 id 取源媒体建独立 URL（§7.3 拷贝语义）；冲突期条目拒绝服务
   * （issue #25）。 */
  mediaUrl: (asset: Pick<LibraryAsset, 'id' | 'conflicted'>): Promise<string> => {
    if (isTauri) return tauriMediaUrl(asset)
    if (asset.conflicted) return Promise.reject(new Error('资产处于删除事务冲突期，媒体不可用'))
    const hit = memoryAssets.get(asset.id)
    if (!hit) return Promise.reject(new Error(`资产不存在：${asset.id}`))
    return Promise.resolve(URL.createObjectURL(hit.blob))
  },
}
