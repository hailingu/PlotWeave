/**
 * 旧格式迁移（docs/data-model.md v1 §11.1 迁移链首环的前半段）：
 * schemaVersion 0 文档的节点/设定集仍是「引用 id 化之前」的形态，
 * 本模块把它升级为当前运行态形状，再由 convert.ts 包装为 v1 信封。
 */
import type { CanvasNode } from '../editor/nodes/types'
import {
  branchOptionHandle,
  branchOptionIdOf,
} from '../editor/graphRules'
import {
  newEntityId,
  normalizeSettings,
  type ProjectSettings,
} from '../editor/settings'
import { uid } from '../uid'
import type { ProjectContent } from './content'

/** 集标题表归一化：JSON 键是字符串，只保留「数字键 → 非空标题」映射。 */
export function normalizeEpisodeTitles(v: unknown): Record<number, string> {
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
 * 旧 schema → 新 schema 迁移（保用户数据）：
 * - scene.characters（头像对象）→ characterIds；scene.location（字符串）→ locationId；
 *   dialogue 台词 speaker（对象）→ 实体 id。
 * - 列表项稳定 id 回填（S6479）：dialogue.lines / branch.options / shot.refs；
 *   branch 选项字符串形态升级为 {id, label} 对象。
 * - 缺失的设定集实体就地补建：角色按「名字首字 + 渐变」匹配，地点按名字匹配；
 *   匹配不到建新实体（角色名回退头像单字，用户可改名）。
 */
export function migrateProjectDocument(doc: ProjectContent): {
  doc: ProjectContent
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
        let next = line
        if (next.kind === 'line' && next.speaker && typeof next.speaker === 'object') {
          const av = next.speaker as { label: string; gradient?: string }
          migrated = true
          next = { ...next, speaker: ensureCharacter(av.label, av.gradient) }
        }
        if (typeof next.id !== 'string') {
          migrated = true
          next = { ...next, id: uid('line') }
        }
        return next
      })
      return { ...node, data: { ...d, lines } } as CanvasNode
    }
    if (node.type === 'branch') {
      const d = node.data
      const options = d.options.map((o) => {
        if (typeof o === 'string') {
          migrated = true
          return { id: uid('opt'), label: o }
        }
        if (typeof (o as { id?: unknown }).id !== 'string') {
          migrated = true
          return { ...(o as { label: string }), id: uid('opt') }
        }
        return o
      })
      return { ...node, data: { ...d, options } } as CanvasNode
    }
    if (node.type === 'shot') {
      const d = node.data
      const refs = d.refs.map((r) => {
        if (typeof (r as { id?: unknown }).id !== 'string') {
          migrated = true
          return { ...r, id: uid('ref') }
        }
        return r
      })
      return { ...node, data: { ...d, refs } } as CanvasNode
    }
    return node
  })

  return { doc: { ...doc, nodes, edges: doc.edges, settings }, migrated }
}

/** 旧运行态的分支边按数组下标定位出口（option-N）；v1 绑稳定选项 id（§4.2 修订）。
 * 须在 migrateProjectDocument 之后调用（此时选项已带稳定 id）；
 * 能解析的下标就地改写，越界的原样保留，留给归一化按孤儿边隔离（§11.3）。 */
export function rewriteIndexOptionHandles(doc: ProjectContent): ProjectContent {
  const nodesById = new Map(doc.nodes.map((n) => [n.id, n]))
  const edges = doc.edges.map((e) => {
    const optionId = branchOptionIdOf(e.sourceHandle)
    // 只改写旧式的纯数字下标句柄；id 句柄与其他端口原样放行
    if (optionId === undefined || !/^\d+$/.test(optionId)) return e
    const src = nodesById.get(e.source)
    if (src?.type !== 'branch') return e
    const option = src.data.options[Number(optionId)]
    return option ? { ...e, sourceHandle: branchOptionHandle(option.id) } : e
  })
  return { ...doc, edges }
}
