/**
 * 项目持久化的内存回退实现（issue #39 自 projectStore.ts 拆出）：纯浏览器
 * 预览无 IPC 时与桌面门面同接口——模块级 Map 会话内持久。存归一化后的
 * 会话文档：与桌面路径同规则（保存即序列化剥离会话态 + 归一化），
 * 行为不因环境分叉；刷新即失，仅保交互可验。
 */
import { parseProject, serializeProject } from '../model/convert'
import type { ProjectContent } from '../model/content'
import { seedProjects } from './seeds'
import type { ProjectSummary } from '../home/projects'

const memoryStore = new Map<string, { doc: ProjectContent; updatedAt: number }>()
let memorySeeded = false

/** 会话文档 → 归一化后的会话文档（serialize 剥离运行态 + parse 重置选中态）；
 * invalidAssetKeys 为 Rust 实路径复验未通过的资产键，归一化据此隔离索引。 */
export function memoryNormalize(
  doc: ProjectContent,
  id: string,
  invalidAssetKeys?: readonly string[],
): ProjectContent {
  return parseProject(serializeProject(doc, id), {
    projectId: id,
    ...(invalidAssetKeys !== undefined ? { invalidAssetKeys } : {}),
  }).content
}

export function memoryList(): ProjectSummary[] {
  if (!memorySeeded) {
    for (const seed of seedProjects()) {
      memoryStore.set(seed.meta.id, {
        doc: memoryNormalize(seed.doc, seed.meta.id),
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

export function memoryCreate(name: string): ProjectSummary {
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

export async function memoryLoad(id: string): Promise<ProjectContent> {
  const entry = memoryStore.get(id)
  if (!entry) throw new Error(`项目不存在：${id}`)
  // 内存实现只存当前格式，深拷贝即完整文档
  return JSON.parse(JSON.stringify(entry.doc)) as ProjectContent
}

export async function memorySave(id: string, doc: ProjectContent): Promise<void> {
  memoryStore.set(id, { doc: memoryNormalize(doc, id), updatedAt: Date.now() })
}

export async function memoryDelete(id: string): Promise<void> {
  memoryStore.delete(id)
}
