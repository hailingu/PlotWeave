/**
 * 项目持久化前端门面（docs/ui-design.md §3.2、数据模型 §11）。
 * Tauri 环境走 Rust 命令（JSON 文件落盘于应用数据目录）；
 * 纯浏览器预览无 IPC，回退为同接口的内存实现（刷新即失，仅保交互可验）。
 * 统一约定：updatedAt 对外为 ISO 字符串（Rust 存 epoch 毫秒，在此转换）。
 */
import type { Edge } from '@xyflow/react'
import type { CanvasNode } from './editor/nodes/types'
import { SAMPLE_NODES, SAMPLE_EDGES } from './editor/sampleGraph'
import type { ProjectSummary } from './home/projects'

/** 项目完整内容：名称 + 画布两数组。 */
export interface ProjectDocument {
  name: string
  nodes: CanvasNode[]
  edges: Edge[]
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
      doc: { name: '午夜出租车', nodes: SAMPLE_NODES, edges: SAMPLE_EDGES },
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
      doc: { name: '都市奇缘', nodes: SAMPLE_NODES, edges: SAMPLE_EDGES },
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
  return metas.map(toSummary)
}

async function tauriCreate(name: string): Promise<ProjectSummary> {
  const { invoke } = await import('@tauri-apps/api/core')
  return toSummary(await invoke('create_project', { name }))
}

async function tauriLoad(id: string): Promise<ProjectDocument> {
  const { invoke } = await import('@tauri-apps/api/core')
  const file = await invoke<{ name: string; nodes: CanvasNode[]; edges: Edge[] }>(
    'load_project',
    { id },
  )
  return { name: file.name, nodes: file.nodes, edges: file.edges }
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
  const id = `local-${Date.now().toString(36)}`
  const now = Date.now()
  memoryStore.set(id, { doc: { name, nodes: [], edges: [] }, updatedAt: now })
  return { id, name, sceneCount: 0, updatedAt: new Date(now).toISOString() }
}

async function memoryLoad(id: string): Promise<ProjectDocument> {
  const entry = memoryStore.get(id)
  if (!entry) throw new Error(`项目不存在：${id}`)
  return JSON.parse(JSON.stringify(entry.doc)) as ProjectDocument
}

async function memorySave(id: string, doc: ProjectDocument): Promise<void> {
  memoryStore.set(id, { doc, updatedAt: Date.now() })
}

async function memoryDelete(id: string): Promise<void> {
  memoryStore.delete(id)
}
