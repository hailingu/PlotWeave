/**
 * 设定集 → 画布的拖拽协议（docs/ui-design.md §5 建立引用 = 拖拽）。
 * 左栏设定集条目按此 MIME 携带实体 id；画布 drop 时经 ProjectSettings
 * 解析建立引用，或在空白处生成预填节点。payload 为纯 JSON。
 */
export const PW_ENTITY_MIME = 'application/x-plotweave-entity'

/** 实体拖拽载荷：kind + 实体 id（名字冗余携带，用于预填节点展示回退）。 */
export type EntityDragPayload =
  | { kind: 'character'; id: string; name: string }
  | { kind: 'location'; id: string; name: string }

/** 从 dataTransfer 解析实体；非本协议或非法 JSON 返回 null。 */
export function readEntityPayload(e: { getData: (type: string) => string }): EntityDragPayload | null {
  try {
    const raw = e.getData(PW_ENTITY_MIME)
    if (!raw) return null
    const parsed = JSON.parse(raw) as EntityDragPayload
    if (
      (parsed.kind === 'character' || parsed.kind === 'location') &&
      typeof parsed.id === 'string' &&
      typeof parsed.name === 'string'
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}
