/**
 * 项目持久化前端门面（docs/ui-design.md §3.2、数据模型 v1 §10–§11）。
 * Tauri 环境走 Rust 命令（JSON 文件落盘于应用数据目录）；
 * 纯浏览器预览无 IPC，回退为同接口的内存实现（刷新即失，仅保交互可验）。
 * 落盘格式为 ProjectDocument（src/model/document.ts）；序列化/归一化/迁移
 * 在 src/model/convert.ts。统一约定：updatedAt 对外为 ISO 字符串。
 */
import { parseProject, serializeProject } from './model/convert'
import type { ProjectContent } from './model/content'
import { SAMPLE_NODES, SAMPLE_EDGES } from './editor/sampleGraph'
import { SAMPLE_SETTINGS } from './editor/sampleData'
import type { ProjectSummary } from './home/projects'

export type { ProjectContent }

/** 首次启动的种子项目：沿用演示画布，让首页与编辑器开箱即有内容。 */
function seedProjects(): { meta: ProjectSummary; doc: ProjectContent }[] {
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

/** Rust ProjectMeta → 首页 ProjectSummary；updated_at 为 ISO 字符串。
 * 非法时间戳（空串/坏格式）回退 epoch，绝不让 new Date 抛错清空首页列表。 */
function toSummary(m: {
  id: string
  name: string
  updated_at: string
  scene_count: number
  ending_count: number
}): ProjectSummary {
  const t = Date.parse(m.updated_at)
  return {
    id: m.id,
    name: m.name,
    sceneCount: m.scene_count,
    ...(m.ending_count > 1 ? { endingCount: m.ending_count } : {}),
    updatedAt: new Date(Number.isFinite(t) ? t : 0).toISOString(),
  }
}

/** 内存回退实现：模块级 Map，会话内持久。 */
const memoryStore = new Map<string, { doc: ProjectContent; updatedAt: number }>()
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
  const countScenes = (nodes: ProjectContent['nodes']) =>
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
    { id: string; name: string; updated_at: string; scene_count: number; ending_count: number }[]
  >('list_projects')
  // 首次启动（无任何项目文件）时写入种子示例，保证开箱即有内容
  if (metas.length === 0) {
    for (const seed of seedProjects()) {
      await tauriSave(seed.meta.id, seed.doc)
    }
    return tauriList()
  }
  // 种子文件升级：示例项目仍是旧格式（schemaVersion 0）时直接覆盖新种子
  for (const meta of metas) {
    if (!meta.id.startsWith('sample-')) continue
    const seed = seedProjects().find((s) => s.meta.id === meta.id)
    if (!seed) continue
    const file = await invoke<unknown>('load_project', { id: meta.id })
    if (parseProject(file).migrated) {
      await tauriSave(meta.id, seed.doc)
    }
  }
  return metas.map(toSummary)
}

async function tauriCreate(name: string): Promise<ProjectSummary> {
  const { invoke } = await import('@tauri-apps/api/core')
  return toSummary(
    await invoke<{ id: string; name: string; updated_at: string; scene_count: number; ending_count: number }>(
      'create_project',
      { name },
    ),
  )
}

async function tauriLoad(id: string): Promise<ProjectContent> {
  const { invoke } = await import('@tauri-apps/api/core')
  const file = await invoke<unknown>('load_project', { id })
  // §11 归一化管线：迁移 + 孤儿边隔离 + 悬空引用标记
  const { content, migrated, warnings } = parseProject(file)
  for (const w of warnings) console.warn(`[projectStore] ${w}`)
  // 迁移发生则写回磁盘，下次打开不再迁移
  if (migrated) void tauriSave(id, content)
  return content
}

async function tauriSave(id: string, doc: ProjectContent): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('save_project', { id, doc: serializeProject(doc, id) })
}

/** 统一门面：两种环境同签名。 */
export const projectStore = {
  list: (): Promise<ProjectSummary[]> =>
    isTauri ? tauriList() : Promise.resolve(memoryList()),

  create: (name: string): Promise<ProjectSummary> =>
    isTauri
      ? tauriCreate(name)
      : Promise.resolve(memoryCreate(name)),

  load: (id: string): Promise<ProjectContent> =>
    isTauri ? tauriLoad(id) : memoryLoad(id),

  save: (id: string, doc: ProjectContent): Promise<void> =>
    isTauri ? tauriSave(id, doc) : memorySave(id, doc),

  /** 删除项目（首页卡片菜单，§3.2；确认框由界面层负责）。 */
  delete: (id: string): Promise<void> =>
    isTauri
      ? import('@tauri-apps/api/core').then(({ invoke }) => invoke('delete_project', { id }))
      : memoryDelete(id),

  /** 复制项目：读原文档 → 新建「副本」项目 → 写入画布（§3.2）。
   * 副本创建时间取复制时刻。资产索引随文档原样带走——与 avatarAssetId
   * 等引用字段保持一致解析（§8.1）；媒体文件整目录拷贝随 §7.1 落地后
   * 升级为 Rust 侧原子复制（§7.3）。 */
  duplicate: async (id: string): Promise<ProjectSummary> => {
    const doc = await projectStore.load(id)
    const name = `${doc.name} 副本`
    const meta = await projectStore.create(name)
    await projectStore.saveQuiet(meta.id, { ...doc, name, createdAt: undefined })
    return { ...meta, sceneCount: meta.sceneCount }
  },

  /** 静默吞掉持久化错误：画布交互不因落盘失败中断，仅控制台留痕。 */
  saveQuiet: async (id: string, doc: ProjectContent): Promise<void> => {
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
  memoryStore.set(id, {
    doc: {
      name,
      createdAt: new Date(now).toISOString(),
      nodes: [],
      edges: [],
      settings: { characters: [], locations: [] },
    },
    updatedAt: now,
  })
  return { id, name, sceneCount: 0, updatedAt: new Date(now).toISOString() }
}

async function memoryLoad(id: string): Promise<ProjectContent> {
  const entry = memoryStore.get(id)
  if (!entry) throw new Error(`项目不存在：${id}`)
  // 内存实现只存当前格式，深拷贝即完整文档
  return JSON.parse(JSON.stringify(entry.doc)) as ProjectContent
}

async function memorySave(id: string, doc: ProjectContent): Promise<void> {
  memoryStore.set(id, { doc, updatedAt: Date.now() })
}

async function memoryDelete(id: string): Promise<void> {
  memoryStore.delete(id)
}
