import type { Edge } from '@xyflow/react'
import { SCENE_SHOT_HANDLE, branchOptionIdOf, edgeKindOf } from '../graphRules'
import type { CanvasNode } from '../nodes/types'

/**
 * 画布上下文快照的构建（docs/ui-design.md §6「了解当前画布」、数据模型 §12.2）。
 * 纯函数：输入画布节点/边与设定集解析器，输出给 LLM 的压缩文本——
 * 节点 id + 类型标签 + 关键参数、连线语义（剧情流/分支出口/分镜下挂）、
 * 剧情流顺序（大纲投影）与设定集实体 id 清单（AI 写回引用的锚点）。
 * 大项目不喂全量 JSON，长文本截断（§12.2 快照摘要而非全量）。
 */

/** 设定集实体清单与名字解析（EditorView 用 ProjectSettings 实现）。 */
export interface DigestResolvers {
  characters: Array<{ id: string; name: string }>
  locations: Array<{ id: string; name: string }>
  characterName: (id: string) => string | null
  locationName: (id: string) => string | null
}

/** 长文本截断上限：快照是给模型看的摘要，不是全文。 */
const CUT = 40

function cut(s: string, max = CUT): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 集 N 前缀（§3.5 分集）：有 episodeNo 的编剧侧节点才标注。 */
function epTag(data: { episodeNo?: unknown }): string {
  return typeof data.episodeNo === 'number' ? `集${data.episodeNo} ` : ''
}

/** 单个节点行：id + 标签 + 关键参数（按类型裁剪）。 */
function nodeLine(n: CanvasNode, r: DigestResolvers): string {
  switch (n.type) {
    case 'scene': {
      const locName = n.data.locationId
        ? (r.locationName(n.data.locationId) ?? '（已删除）')
        : null
      const parts = [
        n.data.interior ? '内景' : '外景',
        n.data.time,
        locName ? `地点:${locName}` : null,
        n.data.synopsis ? `梗概:${cut(n.data.synopsis)}` : null,
        n.data.characterIds.length > 0
          ? `角色:${n.data.characterIds.map((id) => r.characterName(id) ?? '（已删除）').join('/')}`
          : null,
      ].filter((x): x is string => x !== null && x !== '')
      return `- ${n.id} ${epTag(n.data)}场${pad2(n.data.sceneNo)}·${n.data.name}（${parts.join(' · ')}）`
    }
    case 'beat':
      return `- ${n.id} ${epTag(n.data)}节拍·${n.data.name}（${n.data.tone}）`
    case 'dialogue': {
      const speakers = new Set(
        n.data.lines.flatMap((l) => (l.kind === 'line' && l.speaker ? [l.speaker] : [])),
      )
      const lineCount = n.data.lines.filter((l) => l.kind === 'line').length
      return `- ${n.id} ${epTag(n.data)}对白·${n.data.name}（${speakers.size} 人 · ${lineCount} 句）`
    }
    case 'branch':
      return `- ${n.id} ${epTag(n.data)}分支·${cut(n.data.prompt)}（选项:${n.data.options.map((o) => cut(o.label, 16)).join('/')}）`
    case 'shot':
      return `- ${n.id} SHOT${pad2(n.data.shotNo)}·${n.data.size}（画面:${cut(n.data.picture, 24)} · Prompt:${cut(n.data.prompt, 24)}）`
    case 'image':
      return `- ${n.id} 图片·${cut(n.data.prompt, 24)}（${n.data.size}）`
  }
}

/**
 * 剧情流顺序：sequence 子图的线性投影（§3.5 大纲 = 故事脊线）。
 * 从没有 sequence 入边的节点出发，沿 sequence 边按边序走；被分支
 * 甩出或游离的节点不进脊线。
 */
/** 脊线行的节点标签：按类型取最具辨识度的字段（独立函数替代嵌套三元，S3358）。 */
function spineNodeLabel(n: CanvasNode): string {
  switch (n.type) {
    case 'scene':
      return `场${pad2(n.data.sceneNo)}·${n.data.name}`
    case 'dialogue':
      return `对白·${n.data.name}`
    case 'beat':
      return `节拍·${n.data.name}`
    case 'branch':
      return `分支·${cut(n.data.prompt, 24)}`
    case 'image':
      return `图片·${cut(n.data.prompt, 24)}`
    case 'shot':
      return `SHOT${pad2(n.data.shotNo)}·${n.data.size}`
  }
}

function spineLines(nodes: CanvasNode[], edges: Edge[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const seqEdges = edges.filter((e) => edgeKindOf(e) === 'sequence')
  const hasIncoming = new Set(seqEdges.map((e) => e.target))
  const adjacency = new Map<string, string[]>()
  for (const e of seqEdges) {
    const list = adjacency.get(e.source) ?? []
    list.push(e.target)
    adjacency.set(e.source, list)
  }
  const label = (id: string): string => {
    const n = byId.get(id)
    return n ? spineNodeLabel(n) : id
  }
  const lines: string[] = []
  const visited = new Set<string>()
  const roots = seqEdges.map((e) => e.source).filter((id) => !hasIncoming.has(id))
  const walk = (id: string) => {
    if (visited.has(id)) return
    visited.add(id)
    lines.push(`${lines.length + 1}. ${id} ${label(id)}`)
    for (const next of adjacency.get(id) ?? []) walk(next)
  }
  for (const root of roots) walk(root)
  return lines
}

/** 构建完整画布快照文本。 */
export function buildGraphDigest(nodes: CanvasNode[], edges: Edge[], r: DigestResolvers): string {
  const nodeLines = nodes.map((n) => nodeLine(n, r))
  const edgeLines = edges.map((e) => {
    const kind = edgeKindOf(e)
    const src = nodes.find((n) => n.id === e.source)
    const dst = nodes.find((n) => n.id === e.target)
    const endLabel = (n?: CanvasNode): string => {
      if (!n) return '?'
      if (n.type === 'scene') return `场${pad2(n.data.sceneNo)}·${n.data.name}`
      if (n.type === 'dialogue') return `对白·${n.data.name}`
      if (n.type === 'beat') return `节拍·${n.data.name}`
      if (n.type === 'branch') return `分支·${cut(n.data.prompt, 24)}`
      if (n.type === 'image') return `图片·${cut(n.data.prompt, 24)}`
      return `SHOT${pad2(n.data.shotNo)}·${n.data.size}`
    }
    if (kind === 'branch') {
      // 端口绑稳定选项 id：按 id 回源解析选项文案，不给模型看下标
      const optId = branchOptionIdOf(e.sourceHandle)
      const opt = src?.type === 'branch' ? src.data.options.find((o) => o.id === optId) : undefined
      return `- branch(选项${opt?.label ?? '?'} · ${e.sourceHandle ?? '?'}): ${e.source} → ${e.target}（${endLabel(src)} → ${endLabel(dst)}）`
    }
    if (kind === 'attach' || e.sourceHandle === SCENE_SHOT_HANDLE) {
      return `- attach: ${e.source} → ${e.target}（下挂分镜：${endLabel(src)} → ${endLabel(dst)}）`
    }
    return `- sequence: ${e.source} → ${e.target}（${endLabel(src)} → ${endLabel(dst)}）`
  })

  const spine = spineLines(nodes, edges)
  const sections = [
    `节点（id 标签 · 参数）：`,
    ...(nodeLines.length > 0 ? nodeLines : ['（空画布）']),
    `连线（类型: source → target）：`,
    ...(edgeLines.length > 0 ? edgeLines : ['（无）']),
    `剧情流顺序（大纲投影）：`,
    ...(spine.length > 0 ? spine : ['（尚未连成剧情流）']),
    `设定集（id 名称，AI 写回 characterIds/locationId 用）：`,
    ...(r.characters.length > 0
      ? r.characters.map((c) => `- 角色 ${c.id} ${c.name}`)
      : ['- （无角色）']),
    ...(r.locations.length > 0
      ? r.locations.map((l) => `- 地点 ${l.id} ${l.name}`)
      : ['- （无地点）']),
  ]
  return sections.join('\n')
}
