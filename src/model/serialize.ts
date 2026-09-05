/**
 * 会话文档 ⇄ ProjectDocument 的序列化方向（docs/data-model.md v1 §3）。
 * 序列化只存语义字段：React Flow 运行态（selected/className/measured…）
 * 在此剥离；fromDocument 在归一化完成后把落盘文档还原进会话。
 */
import type { Edge } from '@xyflow/react'
import type { CanvasNode, NodeMetaPassthrough } from '../editor/nodes/types'
import { edgeKindOf, SCENE_SHOT_HANDLE } from '../editor/graphRules'
import type { ProjectSettings } from '../editor/settings'
import type { ProjectContent } from './content'
import {
  CURRENT_SCHEMA_VERSION,
  type Point,
  type ProjectDocument,
  type StoryEdge,
  type StoryNode,
} from './document'
import { normalizeEpisodeTitles } from './legacy'


/** meta 时间戳透传（§4.1 演进占位）：会话带上才写回，缺失即省略；非字符串
 * 值不带（下游不落盘即剥离）。 */
function metaTsOf(m: NodeMetaPassthrough['meta']): { createdAt?: string; updatedAt?: string } {
  return {
    ...(typeof m?.createdAt === 'string' ? { createdAt: m.createdAt } : {}),
    ...(typeof m?.updatedAt === 'string' ? { updatedAt: m.updatedAt } : {}),
  }
}

/** episodeNo 携带才写（缺省 = 未分集回退），与可选字段缺省不伪造一致。 */
function episodeNoOf(ep: number | undefined): { episodeNo?: number } {
  return ep !== undefined ? { episodeNo: ep } : {}
}

/** 运行态 → 落盘 layout（§4.1）：位置必填；size/zIndex 携带才写（React Flow
 * 的 width/height/zIndex 合法才搬运，缺省不伪造）。 */
function layoutOf(n: CanvasNode): StoryNode['layout'] {
  return {
    position: { x: n.position.x, y: n.position.y },
    ...(typeof n.width === 'number' && typeof n.height === 'number'
      ? { size: { width: n.width, height: n.height } }
      : {}),
    ...(n.zIndex !== undefined ? { zIndex: n.zIndex } : {}),
  }
}

/** 落盘 layout → 运行态位置/尺寸/层级（size 还原为 React Flow 的
 * width/height，§4.1 双向互转）。 */
function flowLayoutOf(n: StoryNode): {
  position: Point
  width?: number
  height?: number
  zIndex?: number
} {
  return {
    position: { x: n.layout.position.x, y: n.layout.position.y },
    ...(n.layout.size
      ? { width: n.layout.size.width, height: n.layout.size.height }
      : {}),
    ...(n.layout.zIndex !== undefined ? { zIndex: n.layout.zIndex } : {}),
  }
}

/** 落盘 meta 时间戳 → 运行态顶层 meta 透传（均缺省即无 meta 键）。 */
function flowMetaOf(m: NodeMetaPassthrough['meta']): NodeMetaPassthrough {
  const ts = metaTsOf(m)
  return ts.createdAt !== undefined || ts.updatedAt !== undefined ? { meta: ts } : {}
}

/** 节点 → 落盘形态：按 n.type switch 逐分支构造精确的 StoryNode 联合成员
 * （issue 16，穷尽 switch 由返回类型背书）。四分区拆分：名称型节点
 * （scene/beat/dialogue）name/episodeNo 上移 meta.label/episodeNo，其余字段
 * 进 spec；branch 派生标题不落 meta.label 镜像；分镜卡随宿主场景分集、
 * 图片节点非叙事单元不进大纲分组，均不落独立 episodeNo（§3.5/§13）。 */
export function toStoryNode(n: CanvasNode): StoryNode {
  const base = { id: n.id, layout: layoutOf(n), ui: { selected: false, expanded: true } }
  switch (n.type) {
    case 'scene': {
      const { name, episodeNo, ...spec } = n.data
      return {
        ...base,
        type: 'scene',
        data: {
          spec,
          meta: { label: name ?? '', ...episodeNoOf(episodeNo), ...metaTsOf(n.meta) },
        },
      }
    }
    case 'beat': {
      const { name, episodeNo, ...spec } = n.data
      return {
        ...base,
        type: 'beat',
        data: {
          spec,
          meta: { label: name ?? '', ...episodeNoOf(episodeNo), ...metaTsOf(n.meta) },
        },
      }
    }
    case 'dialogue': {
      const { name, episodeNo, ...spec } = n.data
      return {
        ...base,
        type: 'dialogue',
        data: {
          spec,
          meta: { label: name ?? '', ...episodeNoOf(episodeNo), ...metaTsOf(n.meta) },
        },
      }
    }
    case 'branch': {
      // 剥离 name：v1 残留的 spec.name 经归一化透传、fromStoryNode 拍平后可
      // 混入运行态 data（Record 索引签名）；BranchSpec 无 name（派生标题不落
      // 镜像），须剥离避免禁写字段被无限写回——与分镜卡 episodeNo 同域
      const { episodeNo, ...rest } = n.data
      const spec = { ...rest }
      delete spec.name
      return {
        ...base,
        type: 'branch',
        data: { spec, meta: { ...episodeNoOf(episodeNo), ...metaTsOf(n.meta) } },
      }
    }
    case 'shot': {
      // 分镜卡 data 与落盘 spec 同构，整体搬运；不落独立 episodeNo（§3.5）。
      // 剥离 episodeNo/name：v1 残留的 spec.episodeNo 经归一化透传、
      // fromStoryNode 拍平后可混入运行态 data（Record 索引签名），整体展开
      // 会把它无限写回 spec——剥离后保存即修复错集归属。
      // 展开构造：文档侧 spec 接口无索引签名，运行态 *NodeData 因框架约束
      // 继承 Record——展开对象取得隐式签名后方可赋回
      const spec = { ...n.data }
      delete spec.episodeNo
      delete spec.name
      return { ...base, type: 'shot', data: { spec, meta: metaTsOf(n.meta) } }
    }
    case 'image': {
      // 图片节点同构搬运（§13）；同为非叙事单元，剥离同名保留字段防写回
      const spec = { ...n.data }
      delete spec.episodeNo
      delete spec.name
      return { ...base, type: 'image', data: { spec, meta: metaTsOf(n.meta) } }
    }
  }
}

/** 落盘节点 → 运行态：按 n.type switch 逐分支拍平 spec/meta 为精确的
 * *NodeData（issue 16）；ui.selected 恒为 false（§11.2）；可选 layout.size/
 * zIndex 恢复为 React Flow 的 width/height/zIndex；meta.createdAt/updatedAt
 * （§4.1 演进占位）经顶层 meta 透传，非字符串值不带（下游不落盘即剥离）。 */
export function fromStoryNode(n: StoryNode): CanvasNode {
  switch (n.type) {
    case 'scene': {
      const { spec, meta } = n.data
      return {
        id: n.id,
        type: 'scene',
        ...flowLayoutOf(n),
        selected: false,
        ...flowMetaOf(meta),
        data: {
          ...spec,
          name: meta.label,
          // 存储契约可选、运行态必填（§4.2 渲染安全）：归一化已保证字符串，
          // 缺省兜底空串与 normalizeSceneTextFields 同域
          time: spec.time ?? '',
          ...episodeNoOf(meta.episodeNo),
        },
      }
    }
    case 'beat': {
      const { spec, meta } = n.data
      return {
        id: n.id,
        type: 'beat',
        ...flowLayoutOf(n),
        selected: false,
        ...flowMetaOf(meta),
        data: { ...spec, name: meta.label, ...episodeNoOf(meta.episodeNo) },
      }
    }
    case 'dialogue': {
      const { spec, meta } = n.data
      return {
        id: n.id,
        type: 'dialogue',
        ...flowLayoutOf(n),
        selected: false,
        ...flowMetaOf(meta),
        data: { ...spec, name: meta.label, ...episodeNoOf(meta.episodeNo) },
      }
    }
    case 'branch': {
      const { spec, meta } = n.data
      return {
        id: n.id,
        type: 'branch',
        ...flowLayoutOf(n),
        selected: false,
        ...flowMetaOf(meta),
        data: { ...spec, ...episodeNoOf(meta.episodeNo) },
      }
    }
    case 'shot':
      return {
        id: n.id,
        type: 'shot',
        ...flowLayoutOf(n),
        selected: false,
        ...flowMetaOf(n.data.meta),
        data: { ...n.data.spec },
      }
    case 'image':
      return {
        id: n.id,
        type: 'image',
        ...flowLayoutOf(n),
        selected: false,
        ...flowMetaOf(n.data.meta),
        data: { ...n.data.spec },
      }
  }
}

/** 边 → 落盘形态：kind 显式化；branch 胶囊文案是分支选项的派生物，不落拷贝。
 * §5 匿名端口唯一：targetHandle 与 sequence 的 sourceHandle 无法绑定真实
 * 端口（命令层拒绝、加载归一化剥离同域），落盘一律省略。 */
export function toStoryEdge(e: Edge): StoryEdge {
  const base = { id: e.id, source: e.source, target: e.target }
  const order = (e.data as { order?: number } | undefined)?.order
  const optionalOrder = order !== undefined ? { order } : {}
  const kind = edgeKindOf(e)
  if (kind === 'branch') {
    // branch 边必带选项句柄（§5 判别联合）；无句柄属非法形态，归一化按孤儿边隔离
    return { ...base, sourceHandle: e.sourceHandle ?? '', data: { kind: 'branch', ...optionalOrder } }
  }
  if (kind === 'attach') {
    // attach 定义上只从 shots 端口发起（§4.3）：句柄恒为 shots，
    // 顺带归一化历史遗留的缺失/异常句柄
    return { ...base, sourceHandle: SCENE_SHOT_HANDLE, data: { kind: 'attach', ...optionalOrder } }
  }
  return { ...base, data: { kind: 'sequence', ...optionalOrder } }
}

/** 落盘边 → 运行态：恢复 type/className；branch 边运行态 data 仅保留
 * 可选 order——胶囊文案由 BranchEdge 按 sourceHandle 从源节点实时派生，
 * 不落镜像（issue #18）。 */
export function fromStoryEdge(e: StoryEdge): Edge {
  const out: Edge = { id: e.id, source: e.source, target: e.target }
  if (e.sourceHandle) out.sourceHandle = e.sourceHandle
  if (e.targetHandle) out.targetHandle = e.targetHandle
  const order = e.data.order
  if (e.data.kind === 'branch') {
    out.type = 'branch'
    if (order !== undefined) out.data = { order }
  } else {
    out.className = e.data.kind === 'attach' ? 'pw-edge-attach' : 'pw-edge-sequence'
    if (order !== undefined) out.data = { order }
  }
  return out
}

/** 设定集 → 落盘形态：数组转 Record<id, 实体>。props/documents 首版只透传
 * （UI 未开放编辑），原样回写保真。 */
export function toDocSettings(settings: ProjectSettings): ProjectDocument['settings'] {
  return {
    characters: Object.fromEntries(settings.characters.map((c) => [c.id, c])),
    locations: Object.fromEntries(settings.locations.map((l) => [l.id, l])),
    props: Object.fromEntries((settings.props ?? []).map((p) => [p.id, p])),
    documents: Object.fromEntries((settings.documents ?? []).map((d) => [d.id, d])),
  }
}

/** 设定集 → 运行态：Record 转数组（插入序即展示序），容忍缺桶；
 * props/documents 桶透传进会话（契约实体，不得静默丢弃）。 */
export function fromDocSettings(settings: Partial<ProjectDocument['settings']>): ProjectSettings {
  return {
    characters: Object.values(settings.characters ?? {}),
    locations: Object.values(settings.locations ?? {}),
    props: Object.values(settings.props ?? {}),
    documents: Object.values(settings.documents ?? {}),
  }
}

/**
 * 序列化：会话文档 → ProjectDocument。updatedAt 由时钟参数盖戳（默认现在）；
 * createdAt 缺省时与 updatedAt 同刻（新建项目首次落盘）。视口/资产桶缺省时
 * 省略字段而非伪造缺省值——视口省略 = 打开时 fitView；资产省略 = 无资产。
 */
export function serializeProject(
  content: ProjectContent,
  id: string,
  now: Date = new Date(),
): ProjectDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: {
      id,
      name: content.name,
      description: content.description,
      createdAt: content.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    },
    graph: {
      nodes: content.nodes.map(toStoryNode),
      edges: content.edges.map(toStoryEdge),
      ...(content.viewport ? { viewport: content.viewport } : {}),
    },
    settings: toDocSettings(content.settings),
    episodeTitles: content.episodeTitles ?? {},
    assets: content.assets ?? { byId: {} },
  }
}

/** 落盘文档 → 会话文档（归一化之后调用）。视口/资产桶缺省字段保持缺省：
 * 视口缺省 = 打开时 fitView；资产缺省 = 无资产（透传桶，见 content.ts）。
 * episodeTitles 键值域严格化在此收口（§11.1，对所有版本统一执行）。 */
export function fromDocument(doc: ProjectDocument, warnings: string[]): ProjectContent {
  return {
    name: doc.project.name,
    description: doc.project.description,
    createdAt: doc.project.createdAt || undefined,
    nodes: doc.graph.nodes.map(fromStoryNode),
    edges: doc.graph.edges.map(fromStoryEdge),
    settings: fromDocSettings(doc.settings),
    episodeTitles: normalizeEpisodeTitles(doc.episodeTitles, warnings),
    viewport: doc.graph.viewport,
    assets: doc.assets,
  }
}
