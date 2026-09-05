/**
 * 设定集实体 → 画布节点的引用补丁（docs/ui-design.md §5 建立引用 = 拖拽）。
 * 纯函数：给定目标节点与实体，给出要合并进 data 的判别化补丁命令
 * （NodeDataPatch，issue 16）；返回 null = 该节点类型不接收此类实体，
 * 或同类引用已存在（去重）。
 */
import type { EntityDragPayload } from './dragDrop'
import { uid } from '../uid'
import type { NodeDataPatch } from './nodes/patch'
import type { CanvasNode, ShotRef } from './nodes/types'

/** 分镜引用补丁（§4.2 自由位）：引用位（assetId）只绑项目资产，设定集实体
 * 不是合法目标——实体尚无媒体资产时落自由位手填文案（实体名），待资产导入后
 * 由用户改绑；同名自由位已存在则返回 null（去重）。 */
function refPatch(
  refs: ShotRef[],
  kind: 'character' | 'location',
  label: string,
): NodeDataPatch | null {
  if (refs.some((r) => r.label === label)) return null
  return { nodeType: 'shot', patch: { refs: [...refs, { id: uid('ref'), kind, label }] } }
}

/** 角色实体 → 节点的引用补丁：场景出场 / 对白新台词 / 分镜垫图。 */
function characterDropPatch(node: CanvasNode, entity: EntityDragPayload): NodeDataPatch | null {
  if (node.type === 'scene') {
    const ids = node.data.characterIds
    if (ids.includes(entity.id)) return null
    return { nodeType: 'scene', patch: { characterIds: [...ids, entity.id] } }
  }
  if (node.type === 'dialogue') {
    return {
      nodeType: 'dialogue',
      patch: {
        lines: [
          ...node.data.lines,
          { id: uid('line'), kind: 'line', speaker: entity.id, side: 'left', text: '新台词…' },
        ],
      },
    }
  }
  if (node.type === 'shot') return refPatch(node.data.refs, 'character', entity.name)
  return null
}

/** 地点实体 → 节点的引用补丁：场景地点 / 分镜底图。 */
function locationDropPatch(node: CanvasNode, entity: EntityDragPayload): NodeDataPatch | null {
  if (node.type === 'scene') return { nodeType: 'scene', patch: { locationId: entity.id } }
  if (node.type === 'shot') return refPatch(node.data.refs, 'location', entity.name)
  return null
}

/** 设定集实体拖上节点的引用补丁（§5）：按实体 kind 分派。 */
export function entityDropPatch(node: CanvasNode, entity: EntityDragPayload): NodeDataPatch | null {
  if (entity.kind === 'character') return characterDropPatch(node, entity)
  return locationDropPatch(node, entity)
}
