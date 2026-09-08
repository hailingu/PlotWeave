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
  /** 创建时间（§7.2 UTC ISO 8601 字符串，issue #29）。 */
  createdAt: string
  /** 删除事务冲突期标记（§7.2）：媒体打开/导入拒绝服务（issue #25）。 */
  conflicted?: boolean
}

/** 资产组：同一主体（如某角色）的多张视图/变体的集合（§7.2）。 */
export interface AssetGroup {
  id: string
  /** 组名（如「女主·林晚」）。 */
  name: string
  kind: LibraryKind
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
    // createdAt 是 §7.2 UTC ISO 字符串：原样保留，非法/缺失回退空串（评审
    // 修复，PR #33 第四轮——只认 number 会把真实创建时间静默归 0 丢失）
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
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
/** 内存回退的组存储（§7.2）。 */
const memoryGroups = new Map<string, AssetGroup>()

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
    isTauri
      ? tauriList()
      : // 克隆返回（评审修复，PR #36 第九轮）：调用方 mutate 列表资产不得
        // 绕过组校验直接改 memoryAssets
        Promise.resolve([...memoryAssets.values()].map((v) => ({ ...v.asset }))),

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
      createdAt: new Date().toISOString(),
    }
    memoryAssets.set(id, { asset, blob: file })
    return Promise.resolve({ ...asset })
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
    // groupId 校验（评审修复，PR #36 第五轮）：与 Rust update_meta_with 的
    // 复验同语义——组不存在或 kind 不一致即拒绝；null/空串/空白同归清除
    // （第八轮：Rust apply_group_id 把空白归清除，空串不得落入存储）
    const groupIdRaw = patch.groupId
    const groupId =
      typeof groupIdRaw === 'string' && groupIdRaw.trim() !== '' ? groupIdRaw : null
    if (groupId !== null) {
      const group = memoryGroups.get(groupId)
      if (!group) return Promise.reject(new Error(`组不存在：${groupId}`))
      if (group.kind !== hit.asset.kind) {
        return Promise.reject(
          new Error(`组 ${groupId} 的 kind 与资产不一致，拒绝编组`),
        )
      }
    }
    // 归一化后的 groupId 入存储：空串/空白不留（与 Rust 落盘删字段同语义）
    const patchNorm =
      patch.groupId !== undefined ? { ...patch, groupId } : patch
    hit.asset = { ...hit.asset, ...patchNorm }
    memoryAssets.set(id, hit)
    // 克隆返回（评审修复，PR #36 第九轮）：与 list/put 同款
    return Promise.resolve({ ...hit.asset })
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

  /** 组列表：Tauri 读 library.json 的 groups.byId；内存回退读内存组。 */
  listGroups: (): Promise<AssetGroup[]> => {
    if (isTauri) {
      return import('@tauri-apps/api/core').then(async ({ invoke }) => {
        // 完整响应信封（评审修复，PR #36 第一轮）：warnings/cleanupPending
        // 与 tauriList 同款上报——只读组视图不得隐藏修复/隔离诊断
        const index = await invoke<{
          groups?: { byId?: Record<string, unknown> }
          warnings?: unknown[]
          cleanupPending?: unknown[]
        }>('library_list')
        reportLibraryWarnings(index.warnings)
        if (Array.isArray(index.cleanupPending) && index.cleanupPending.length > 0) {
          console.warn('[Library] 删除隔离区待清理：', index.cleanupPending)
        }
        const byId = index.groups?.byId
        const entries = byId && typeof byId === 'object' ? Object.values(byId) : []
        return entries
          .map((g) => g as { id?: unknown; name?: unknown; kind?: unknown })
          .filter(
            (g): g is AssetGroup =>
              typeof g.id === 'string' &&
              typeof g.name === 'string' &&
              typeof g.kind === 'string' &&
              KIND_SET.has(g.kind),
          )
      })
    }
    // 克隆返回（评审修复，PR #36 第六轮）：调用方 mutate 返回值不得改存储
    return Promise.resolve([...memoryGroups.values()].map((g) => ({ ...g })))
  },

  /** 组写入：新建/更新编组；改 kind 与成员冲突即拒绝（§7.2）。 */
  upsertGroup: (group: AssetGroup): Promise<AssetGroup> => {
    if (isTauri) {
      return import('@tauri-apps/api/core').then(async ({ invoke }) => {
        const result = await invoke<AssetGroup & { cleanupPending?: unknown[] }>(
          'upsert_library_group',
          { group },
        )
        reportLibraryWarnings((result as { warnings?: unknown } | null)?.warnings)
        // cleanupPending 随 upsert 响应上报（评审修复，PR #36 第三轮）——
        // 与 list/delete 同款，删除隔离区积压不得静默
        if (result?.cleanupPending?.length) {
          console.warn('[Library] 删除隔离区待清理：', result.cleanupPending)
        }
        return result
      })
    }
    // 内存回退同款形状校验（评审修复，PR #36 第三/四轮）：id 镜像 Rust
    // validate_asset_id（1–64 ASCII 字母数字/_/-）、name 去空白 1–128（合法
    // name 存 trim 后的值）、kind 在声明联合内——与生产路径同语义
    const id =
      typeof group.id === 'string' &&
      group.id.length > 0 &&
      group.id.length <= 64 &&
      [...group.id].every((c) => /^[a-zA-Z0-9_-]$/.test(c))
        ? group.id
        : null
    if (id === null) {
      return Promise.reject(new Error(`组 id 非法：${String(group.id)}`))
    }
    const name = typeof group.name === 'string' ? group.name.trim() : ''
    // 码点计数（评审修复，PR #36 第八轮）：Rust validate_group_for_write 用
    // chars().count()（Unicode 码点），前端 length 是 UTF-16 单元——补充字符
    // （emoji 等）在两侧必须同判，否则预览拒绝生产接受的合法名
    if (name === '' || [...name].length > 128) {
      return Promise.reject(new Error('组名去空白后须为 1–128 字符'))
    }
    if (!KIND_SET.has(group.kind)) {
      return Promise.reject(new Error(`未知组 kind：${String(group.kind)}`))
    }
    // 内存回退同款冲突校验（评审修复，PR #36 第一/二轮）：改 kind 与成员
    // 冲突即拒绝——浏览器预览不得批准生产路径拒绝的状态；**首次创建也扫描**
    // （updateMeta 可先挂悬空 groupId，新建组时 kind 不一致不得放行）
    const normalized: AssetGroup = { ...group, name }
    for (const v of memoryAssets.values()) {
      if (v.asset.groupId === normalized.id && v.asset.kind !== normalized.kind) {
        return Promise.reject(
          new Error(`组 ${normalized.id} 的 kind 与成员资产冲突：存在 kind 不一致的成员`),
        )
      }
    }
    // 克隆存储与返回（评审修复，PR #36 第六轮）：调用方 mutate 传入/返回
    // 的对象不得绕过校验直接改 memoryGroups
    memoryGroups.set(normalized.id, { ...normalized })
    return Promise.resolve({ ...normalized })
  },

  /** 组删除：原子删除组并剥离成员资产的 groupId（§7.2）。 */
  deleteGroup: (id: string): Promise<void> => {
    if (isTauri) {
      return import('@tauri-apps/api/core').then(async ({ invoke }) => {
        const result = await invoke<{ warnings?: unknown; cleanupPending?: unknown[] }>(
          'delete_library_group',
          { id },
        )
        reportLibraryWarnings(result?.warnings)
        if (result?.cleanupPending?.length) {
          console.warn('[Library] 删除隔离区待清理：', result.cleanupPending)
        }
      })
    }
    // 内存回退同款存在性校验（评审修复，PR #36 第一轮）：stale/重复删除
    // 不得静默成功
    if (!memoryGroups.delete(id)) {
      return Promise.reject(new Error(`组不存在：${id}`))
    }
    // 内存回退同款语义（§7.2）：删组剥离成员 groupId
    for (const v of memoryAssets.values()) {
      if (v.asset.groupId === id) v.asset = { ...v.asset, groupId: null }
    }
    return Promise.resolve()
  },
}
