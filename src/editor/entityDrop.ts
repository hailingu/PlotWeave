/**
 * 设定集实体 → 画布节点的引用补丁（docs/ui-design.md §5 建立引用 = 拖拽）。
 * 纯函数：给定目标节点与实体，给出要合并进 data 的补丁；
 * 返回 null = 该节点类型不接收此类实体，或同类引用已存在（去重）。
 */
import type { EntityDragPayload } from './dragDrop'
import { uid } from '../uid'
import type { CanvasNode, ShotRef } from './nodes/types'

/** 分镜引用补丁（§4.2 引用位）：引用目标 = targetId（§8.1 唯一真相），
 * 显示名由解析层按 id 派生；同一目标已引用则返回 null（去重）。 */
function refPatch(
  refs: ShotRef[],
  kind: 'character' | 'location',
  targetId: string,
): Record<string, unknown> | null {
  if (refs.some((r) => r.targetId === targetId)) return null
  return { refs: [...refs, { id: uid('ref'), kind, targetId }] }
}

/** 角色实体 → 节点的引用补丁：场景出场 / 对白新台词 / 分镜垫图。 */
function characterDropPatch(
  node: CanvasNode,
  entity: EntityDragPayload,
): Record<string, unknown> | null {
  if (node.type === 'scene') {
    const ids = node.data.characterIds
    if (ids.includes(entity.id)) return null
    return { characterIds: [...ids, entity.id] }
  }
  if (node.type === 'dialogue') {
    return {
      lines: [
        ...node.data.lines,
        { id: uid('line'), kind: 'line', speaker: entity.id, side: 'left', text: '新台词…' },
      ],
    }
  }
  if (node.type === 'shot') return refPatch(node.data.refs, 'character', entity.id)
  return null
}

/** 地点实体 → 节点的引用补丁：场景地点 / 分镜底图。 */
function locationDropPatch(
  node: CanvasNode,
  entity: EntityDragPayload,
): Record<string, unknown> | null {
  if (node.type === 'scene') return { locationId: entity.id }
  if (node.type === 'shot') return refPatch(node.data.refs, 'location', entity.id)
  return null
}

/** 设定集实体拖上节点的引用补丁（§5）：按实体 kind 分派。 */
export function entityDropPatch(
  node: CanvasNode,
  entity: EntityDragPayload,
): Record<string, unknown> | null {
  if (entity.kind === 'character') return characterDropPatch(node, entity)
  return locationDropPatch(node, entity)
}
