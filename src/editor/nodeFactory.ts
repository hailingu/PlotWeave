/**
 * 新建节点的对象工厂（默认字段 + 落点），纯构建、不入状态、不入栈。
 * 手动创建（＋节点/拖放）与 ✦AI 批量创建共用：against 提供场号/镜号的
 * 编号基线列表（批量连续创建时传模拟数组防止编号重复）；
 * 无显式落点时取视口中心，连续创建按节点数阶梯偏移避免叠死。
 */
import type { XYPosition } from '@xyflow/react'
import { uid } from '../uid'
import type { CreatableType } from './creatable'
import type { CanvasNode } from './nodes/types'

/** 工厂上下文：编号基线 / 对白默认说话人来源 / 视口中心（无画布时为 null → 原点）。 */
export interface NodeFactoryCtx {
  against: CanvasNode[]
  characters: Array<{ id: string }>
  center: XYPosition | null
}

/** 构建指定类型的新节点（selected 默认 true；opts.data 覆盖默认字段）。 */
export function buildCanvasNode(
  type: CreatableType,
  opts: { at?: XYPosition; selected?: boolean; data?: Record<string, unknown> } | undefined,
  ctx: NodeFactoryCtx,
): CanvasNode {
  const nds = ctx.against
  const select = opts?.selected ?? true
  const maxNo = (pick: (n: CanvasNode) => number) =>
    Math.max(0, ...nds.map(pick)) + 1
  let node: CanvasNode
  if (type === 'scene') {
    node = {
      id: uid('scene'),
      type: 'scene',
      position: { x: 0, y: 0 },
      selected: select,
      data: {
        name: '新场景',
        sceneNo: maxNo((n) => (n.type === 'scene' ? n.data.sceneNo : 0)),
        interior: true,
        time: '🌙 夜',
        synopsis: '这一场发生了什么…',
        characterIds: [],
        ...opts?.data,
      },
    }
  } else if (type === 'beat') {
    node = {
      id: uid('beat'),
      type: 'beat',
      position: { x: 0, y: 0 },
      selected: select,
      data: { name: '新节拍', tone: '待定', ...opts?.data },
    }
  } else if (type === 'dialogue') {
    node = {
      id: uid('dialogue'),
      type: 'dialogue',
      position: { x: 0, y: 0 },
      selected: select,
      data: {
        name: '新对白',
        lines: [
          { id: uid('line'), kind: 'line', speaker: ctx.characters[0]?.id, side: 'left', text: '新台词…' },
        ],
        ...opts?.data,
      },
    }
  } else if (type === 'branch') {
    node = {
      id: uid('branch'),
      type: 'branch',
      position: { x: 0, y: 0 },
      selected: select,
      data: {
        prompt: '新的分岔是…？',
        options: [
          { id: uid('opt'), label: '选项 A' },
          { id: uid('opt'), label: '选项 B' },
        ],
        ...opts?.data,
      },
    }
  } else if (type === 'image') {
    node = {
      id: uid('image'),
      type: 'image',
      position: { x: 0, y: 0 },
      selected: select,
      // model 空串 = 未选择：生成入口回退 AppSettings.defaultImage 并引导配置；
      // size 默认竖版短剧画幅（plan.ts IMAGE_SIZES 声明的默认推荐档）
      data: { prompt: '', model: '', size: '1024x1536', outputs: {}, ...opts?.data },
    }
  } else {
    node = {
      id: uid('shot'),
      type: 'shot',
      position: { x: 0, y: 0 },
      selected: select,
      data: {
        shotNo: maxNo((n) => (n.type === 'shot' ? n.data.shotNo : 0)),
        size: '中景',
        picture: '画面描述…',
        prompt: '',
        refs: [],
        ...opts?.data,
      },
    }
  }
  const cascade = (nds.length % 5) * 28
  if (opts?.at) {
    node.position = opts.at
  } else if (ctx.center) {
    node.position = { x: ctx.center.x - 170 + cascade, y: ctx.center.y - 60 + cascade }
  }
  return node
}
