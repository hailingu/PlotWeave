/**
 * 项目持久化前端门面（docs/ui-design.md §3.2、数据模型 §11）。
 * Tauri 环境走 Rust 命令（JSON 文件落盘于应用数据目录）；
 * 纯浏览器预览无 IPC，回退为同接口的内存实现（刷新即失，仅保交互可验）。
 * 统一约定：updatedAt 对外为 ISO 字符串（Rust 存 epoch 毫秒，在此转换）。
 */
import type { Edge } from '@xyflow/react'
import type { CanvasNode } from './editor/nodes/types'
import { SAMPLE_NODES, SAMPLE_EDGES } from './editor/sampleGraph'
import { SAMPLE_SETTINGS } from './editor/sampleData'
import {
  newEntityId,
  normalizeSettings,
  type ProjectSettings,
} from './editor/settings'
import type { ProjectSummary } from './home/projects'

/** 项目完整内容：名称 + 画布两数组 + 设定集 + 大纲集标题。 */
export interface ProjectDocument {
  name: string
  nodes: CanvasNode[]
  edges: Edge[]
  settings: ProjectSettings
  /** 集 = 编号 + 大纲行内标题（§3.5，不建集实体表）；缺省视为无命名集。 */
  episodeTitles?: Record<number, string>
}

/** 集标题表归一化：JSON 键是字符串，只保留「数字键 → 非空标题」映射。 */
function normalizeEpisodeTitles(v: unknown): Record<number, string> {
  const out: Record<number, string> = {}
  if (typeof v !== 'object' || v === null) return out
  for (const [k, title] of Object.entries(v as Record<string, unknown>)) {
    const ep = Number(k)
    if (Number.isInteger(ep) && ep > 0 && typeof title === 'string' && title.trim() !== '') {
      out[ep] = title.trim()
    }
  }
  return out
}

/**
 * 旧 schema 判定（引用 id 化之前落盘的文档）：
 * scene 的 characters 是头像对象数组 / location 是字符串 / 对白 speaker 是对象。
 */
function needsMigration(file: { nodes?: CanvasNode[]; settings?: unknown }): boolean {
  const nodes = file.nodes ?? []
  if (Array.isArray(file.settings) || (file.settings && typeof file.settings === 'object' && file.settings !== null && !('characters' in file.settings))) {
    // settings 缺失视作旧文件，由迁移补全
  }
  return nodes.some((n) => {
    const d = n.data as Record<string, unknown>
    if (n.type === 'scene') {
      return Array.isArray(d.characters) || typeof d.location === 'string' || !Array.isArray(d.characterIds)
    }
    if (n.type === 'dialogue') {
      return Array.isArray(d.lines) && (d.lines as { speaker?: unknown }[]).some((l) => l.speaker && typeof l.speaker === 'object')
    }
    return false
  }) || file.settings === undefined
}

/**
 * 旧 schema → 新 schema 迁移（保用户数据）：
 * - scene.characters（头像对象）→ characterIds；scene.location（字符串）→ locationId；
 *   dialogue 台词 speaker（对象）→ 实体 id。
 * - 缺失的设定集实体就地补建：角色按「名字首字 + 渐变」匹配，地点按名字匹配；
 *   匹配不到建新实体（角色名回退头像单字，用户可改名）。
 */
export function migrateProjectDocument(doc: ProjectDocument): {
  doc: ProjectDocument
  migrated: boolean
} {
  const settings: ProjectSettings = normalizeSettings(doc.settings)
  let migrated = false

  const ensureCharacter = (label: string, gradient?: string): string => {
    const hit =
      settings.characters.find((c) => c.gradient === gradient && c.name.startsWith(label)) ??
      settings.characters.find((c) => c.name.startsWith(label))
    if (hit) return hit.id
    const entity = {
      id: newEntityId('ch'),
      name: label,
      gradient: gradient ?? 'linear-gradient(135deg,#8e8e93,#636366)',
    }
    settings.characters.push(entity)
    migrated = true
    return entity.id
  }

  const ensureLocation = (name: string): string => {
    const hit = settings.locations.find((l) => l.name === name)
    if (hit) return hit.id
    const entity = { id: newEntityId('loc'), name }
    settings.locations.push(entity)
    migrated = true
    return entity.id
  }

  const nodes = doc.nodes.map((node) => {
    if (node.type === 'scene') {
      const d = { ...(node.data as Record<string, unknown>) }
      const avatars = d.characters
      let characterIds: string[]
      if (Array.isArray(avatars)) {
        characterIds = (avatars as { label: string; gradient?: string }[]).map((av) =>
          ensureCharacter(av.label, av.gradient),
        )
        delete d.characters
        migrated = true
      } else if (Array.isArray(d.characterIds)) {
        characterIds = d.characterIds as string[]
      } else {
        characterIds = []
        migrated = true
      }
      let locationId = d.locationId as string | undefined
      if (typeof d.location === 'string') {
        locationId = ensureLocation(d.location)
        delete d.location
        migrated = true
      }
      return { ...node, data: { ...d, characterIds, locationId } } as CanvasNode
    }
    if (node.type === 'dialogue') {
      const d = node.data
      const lines = d.lines.map((line) => {
        if (line.kind === 'line' && line.speaker && typeof line.speaker === 'object') {
          const av = line.speaker as { label: string; gradient?: string }
          migrated = true
          return { ...line, speaker: ensureCharacter(av.label, av.gradient) }
        }
        return line
      })
      return { ...node, data: { ...d, lines } } as CanvasNode
    }
    return node
  })

  return { doc: { ...doc, nodes, edges: doc.edges, settings }, migrated }
}

/** 首次启动的种子项目：沿用演示画布，让首页与编辑器开箱即有内容。 */
function seedProjects(): { meta: ProjectSummary; doc: ProjectDocument }[] {
  const hoursAgo = (h: number) =>
    new Date(Date.now() - h * 3_600_000).toISOString()
  const sceneCount = SAMPLE_NODES.filter((n) => n.type === 'scene').length
  return [
    {
      meta: {
        id: 'sample-wu-ye-chu-zu-che',
        name: '午夜出租车',
        sceneCount,
        endingCount: 2,
        updatedAt: hoursAgo(26),
      },
      doc: { name: '午夜出租车', nodes: SAMPLE_NODES, edges: SAMPLE_EDGES, settings: SAMPLE_SETTINGS },
    },
    {
      meta: {
        id: 'sample-du-shi-qi-yuan',
        name: '都市奇缘',
        sceneCount: 24,
        endingCount: 2,
        cover: 'linear-gradient(160deg, #2b2f4c, #e0176e)',
        updatedAt: hoursAgo(2),
      },
      doc: { name: '都市奇缘', nodes: SAMPLE_NODES, edges: SAMPLE_EDGES, settings: SAMPLE_SETTINGS },
    },
  ]
}

const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** Rust ProjectMeta（epoch 毫秒）→ 首页 ProjectSummary（ISO）。 */
function toSummary(m: {
  id: string
  name: string
  updated_at: number
  scene_count: number
  ending_count: number
}): ProjectSummary {
  return {
    id: m.id,
    name: m.name,
    sceneCount: m.scene_count,
    ...(m.ending_count > 1 ? { endingCount: m.ending_count } : {}),
    updatedAt: new Date(m.updated_at).toISOString(),
  }
}

/** 内存回退实现：模块级 Map，会话内持久。 */
const memoryStore = new Map<string, { doc: ProjectDocument; updatedAt: number }>()
let memorySeeded = false

function memoryList(): ProjectSummary[] {
  if (!memorySeeded) {
    for (const seed of seedProjects()) {
      memoryStore.set(seed.meta.id, {
        doc: seed.doc,
        updatedAt: Date.parse(seed.meta.updatedAt),
      })
    }
    memorySeeded = true
  }
  const countScenes = (nodes: CanvasNode[]) =>
    nodes.filter((n) => n.type === 'scene').length
  return [...memoryStore.entries()]
    .map(([id, { doc, updatedAt }]) => {
      const hasOutgoing = new Set(
        doc.edges.map((e) => e.source),
      )
      const endings = doc.nodes.filter(
        (n) => n.type === 'scene' && !hasOutgoing.has(n.id),
      ).length
      return {
        id,
        name: doc.name,
        sceneCount: countScenes(doc.nodes),
        ...(endings > 1 ? { endingCount: endings } : {}),
        updatedAt: new Date(updatedAt).toISOString(),
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

async function tauriList(): Promise<ProjectSummary[]> {
  const { invoke } = await import('@tauri-apps/api/core')
  const metas = await invoke<
    { id: string; name: string; updated_at: number; scene_count: number; ending_count: number }[]
  >('list_projects')
  // 首次启动（无任何项目文件）时写入种子示例，保证开箱即有内容
  if (metas.length === 0) {
    for (const seed of seedProjects()) {
      await tauriSave(seed.meta.id, seed.doc)
    }
    return tauriList()
  }
  // 种子文件升级：示例项目仍是旧 schema（引用 id 化之前落盘）时直接覆盖新种子
  for (const meta of metas) {
    if (!meta.id.startsWith('sample-')) continue
    const seed = seedProjects().find((s) => s.meta.id === meta.id)
    if (!seed) continue
    const file = await invoke<{ nodes: CanvasNode[]; settings?: unknown }>('load_project', {
      id: meta.id,
    })
    if (needsMigration(file)) {
      await tauriSave(meta.id, seed.doc)
    }
  }
  return metas.map(toSummary)
}

async function tauriCreate(name: string): Promise<ProjectSummary> {
  const { invoke } = await import('@tauri-apps/api/core')
  return toSummary(await invoke('create_project', { name }))
}

async function tauriLoad(id: string): Promise<ProjectDocument> {
  const { invoke } = await import('@tauri-apps/api/core')
  const file = await invoke<{
    name: string
    nodes: CanvasNode[]
    edges: Edge[]
    settings?: unknown
    episodeTitles?: unknown
  }>('load_project', { id })
  const doc = migrateProjectDocument({
    name: file.name,
    nodes: file.nodes,
    edges: file.edges,
    settings: normalizeSettings(file.settings),
    episodeTitles: normalizeEpisodeTitles(file.episodeTitles),
  })
  // 迁移发生则写回磁盘，下次打开不再迁移
  if (doc.migrated) void tauriSave(id, doc.doc)
  return doc.doc
}

async function tauriSave(id: string, doc: ProjectDocument): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('save_project', {
    id,
    doc: {
      name: doc.name,
      updated_at: 0, // 由 Rust 端盖服务端时间
      nodes: doc.nodes,
      edges: doc.edges,
      settings: doc.settings,
      episodeTitles: doc.episodeTitles ?? {},
    },
  })
}

/** 统一门面：两种环境同签名。 */
export const projectStore = {
  list: (): Promise<ProjectSummary[]> =>
    isTauri ? tauriList() : Promise.resolve(memoryList()),

  create: (name: string): Promise<ProjectSummary> =>
    isTauri
      ? tauriCreate(name)
      : Promise.resolve(memoryCreate(name)),

  load: (id: string): Promise<ProjectDocument> =>
    isTauri ? tauriLoad(id) : memoryLoad(id),

  save: (id: string, doc: ProjectDocument): Promise<void> =>
    isTauri ? tauriSave(id, doc) : memorySave(id, doc),

  /** 删除项目（首页卡片菜单，§3.2；确认框由界面层负责）。 */
  delete: (id: string): Promise<void> =>
    isTauri
      ? import('@tauri-apps/api/core').then(({ invoke }) => invoke('delete_project', { id }))
      : memoryDelete(id),

  /** 复制项目：读原文档 → 新建「副本」项目 → 写入画布（§3.2）。 */
  duplicate: async (id: string): Promise<ProjectSummary> => {
    const doc = await projectStore.load(id)
    const name = `${doc.name} 副本`
    const meta = await projectStore.create(name)
    await projectStore.saveQuiet(meta.id, { ...doc, name })
    return { ...meta, sceneCount: meta.sceneCount }
  },

  /** 静默吞掉持久化错误：画布交互不因落盘失败中断，仅控制台留痕。 */
  saveQuiet: async (id: string, doc: ProjectDocument): Promise<void> => {
    try {
      await projectStore.save(id, doc)
    } catch (err) {
      console.warn('[projectStore] 保存失败', err)
    }
  },
}

function memoryCreate(name: string): ProjectSummary {
  // 随机尾防同毫秒碰撞（如「复制」紧跟「新建」）：时间戳 id 撞 key 会静默覆盖项目
  const id = `local-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
  const now = Date.now()
  memoryStore.set(id, { doc: { name, nodes: [], edges: [], settings: { characters: [], locations: [] } }, updatedAt: now })
  return { id, name, sceneCount: 0, updatedAt: new Date(now).toISOString() }
}

async function memoryLoad(id: string): Promise<ProjectDocument> {
  const entry = memoryStore.get(id)
  if (!entry) throw new Error(`项目不存在：${id}`)
  const raw = JSON.parse(JSON.stringify(entry.doc)) as ProjectDocument
  return migrateProjectDocument(raw).doc
}

async function memorySave(id: string, doc: ProjectDocument): Promise<void> {
  memoryStore.set(id, { doc, updatedAt: Date.now() })
}

async function memoryDelete(id: string): Promise<void> {
  memoryStore.delete(id)
}
