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

/** 集标题表归一化（§11.1 键值域，对所有版本统一执行）：JSON 键是字符串，
 * 只保留「规范十进制正整数键（安全整数范围内）→ 非空白标题」映射——
 * "01"/"1e0"/" 1" 等非规范书写与规范键折叠到同一集号、转换时按遍历序
 * 静默覆盖其一，删除并警告；零/负/小数/超安全整数键同论。值为非字符串
 * 或去空白后为空串的删除并警告（与 set_episode_title 落盘口径一致）。
 * 数组形态不是 Record：数组下标不参与转换，整体重置为空并警告。 */
export function normalizeEpisodeTitles(
  v: unknown,
  warnings?: string[],
): Record<number, string> {
  const out: Record<number, string> = {}
  if (v === undefined || v === null) return out
  if (typeof v !== 'object' || Array.isArray(v)) {
    warnings?.push('episodeTitles 不是普通键值对象，已重置为空 Record')
    return out
  }
  for (const [k, title] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[1-9]\d*$/.test(k) || !Number.isSafeInteger(Number(k))) {
      warnings?.push(`episodeTitles 键 "${k}" 不是规范十进制正整数（或超出安全整数范围），已删除`)
      continue
    }
    if (typeof title !== 'string') {
      warnings?.push(`episodeTitles["${k}"] 的值不是字符串，已删除`)
      continue
    }
    const trimmed = title.trim()
    if (!trimmed) {
      warnings?.push(`episodeTitles["${k}"] 的标题去空白后为空，已删除`)
      continue
    }
    out[Number(k)] = trimmed
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
 * - 键控身份的数组语义保全：设定集数组与 branch 选项的重复/空白 id 保首见、
 *   后续就地重发——下游 Record 键控只留末见、下标句柄改写假定选项 id 唯一，
 *   不在此修复会丢实体或让连线静默滑向首见项。
 */
export function migrateProjectDocument(doc: ProjectContent): {
  doc: ProjectContent
  migrated: boolean
} {
  const settings: ProjectSettings = normalizeSettings(doc.settings)
  let migrated = false

  /** v0 设定集数组的实体 id 修复（先于 Record 键控）：数组语义下同 id 引用
   * 命中首见实体；缺失/非字符串/空白或与首见重复的 id 就地重发，首见不动——
   * 既不丢实体数据，也不改变既有引用的指向。 */
  const reissueEntityIds = <T extends { id?: unknown }>(list: T[], prefix: 'ch' | 'loc'): T[] => {
    const seen = new Set<string>()
    return list.map((e) => {
      const raw = e !== null && typeof e === 'object' ? e.id : undefined
      const id = typeof raw === 'string' ? raw : ''
      if (id.trim() && !seen.has(id)) {
        seen.add(id)
        return e
      }
      migrated = true
      const nid = newEntityId(prefix)
      seen.add(nid)
      return { ...(e as object), id: nid } as T
    })
  }
  settings.characters = reissueEntityIds(settings.characters, 'ch')
  settings.locations = reissueEntityIds(settings.locations, 'loc')

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
      // 下标句柄改写（rewriteIndexOptionHandles）与 v1 归一化的键控列表修复
      // 都以「选项 id 唯一非空」为前提：空白或与首见重复的 id 在此保首见重发，
      // 否则下标改写绑定的重复 id 会被归一化二次重发，连线静默滑向首见选项
      const seen = new Set<string>()
      const options = d.options.map((o) => {
        if (typeof o === 'string') {
          migrated = true
          const id = uid('opt')
          seen.add(id)
          return { id, label: o }
        }
        const raw = (o as { id?: unknown }).id
        const id = typeof raw === 'string' ? raw : ''
        if (!id.trim() || seen.has(id)) {
          migrated = true
          const nid = uid('opt')
          seen.add(nid)
          return { ...(o as { label: string }), id: nid }
        }
        seen.add(id)
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
