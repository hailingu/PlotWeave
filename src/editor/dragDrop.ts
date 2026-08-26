import type { NodeAvatar } from './nodes/types'

/**
 * 设定集 → 画布的拖拽协议（docs/ui-design.md §5 建立引用 = 拖拽）。
 * 左栏设定集条目按此 MIME 携带实体数据；画布 drop 时解析并建立引用，
 * 或在空白处生成预填节点。payload 为纯 JSON（可安全 dataTransfer 往返）。
 */
export const PW_ENTITY_MIME = 'application/x-plotweave-entity'

/** 角色实体：拖上索引卡/对白/分镜卡建立引用，拖空白生成预填场景。 */
export interface CharacterDragPayload {
  kind: 'character'
  name: string
  avatar: NodeAvatar
}

/** 地点实体：拖上索引卡设置地点，拖上分镜卡添加底图引用，拖空白生成预填场景。 */
export interface LocationDragPayload {
  kind: 'location'
  name: string
  note?: string
}

export type EntityDragPayload = CharacterDragPayload | LocationDragPayload

/** 从 dataTransfer 解析实体；非本协议或非法 JSON 返回 null。 */
export function readEntityPayload(e: { getData: (type: string) => string }): EntityDragPayload | null {
  try {
    const raw = e.getData(PW_ENTITY_MIME)
    if (!raw) return null
    const parsed = JSON.parse(raw) as EntityDragPayload
    if (parsed.kind === 'character' || parsed.kind === 'location') return parsed
    return null
  } catch {
    return null
  }
}
