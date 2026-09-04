/**
 * 设定集 → 画布的拖拽协议（docs/ui-design.md §5 建立引用 = 拖拽）。
 * 左栏设定集条目按此 MIME 携带实体 id；画布 drop 时经 ProjectSettings
 * 解析建立引用，或在空白处生成预填节点。payload 为纯 JSON。
 */
export const PW_ENTITY_MIME = 'application/x-plotweave-entity'

/** 资产库 → 画布的拖拽协议（§7.3 库资产拖上画布 = 拷贝进项目并绑定引用位）：
 * 左栏资产库条目按此 MIME 携带库资产 id/name/kind/mime。 */
export const PW_LIBRARY_ASSET_MIME = 'application/x-plotweave-library-asset'

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

/** 资产库拖拽载荷：库资产 id + 名称 + 库分类 + MIME（kind/mime 决定可绑的
 * 引用位类型，name 供错误提示与展示回退）。 */
export interface LibraryAssetDragPayload {
  id: string
  name: string
  kind: string
  mime: string
}

/** 从 dataTransfer 解析库资产载荷；非本协议或非法 JSON 返回 null。 */
export function readLibraryAssetPayload(e: {
  getData: (type: string) => string
}): LibraryAssetDragPayload | null {
  try {
    const raw = e.getData(PW_LIBRARY_ASSET_MIME)
    if (!raw) return null
    const parsed = JSON.parse(raw) as LibraryAssetDragPayload
    if (
      typeof parsed.id === 'string' &&
      typeof parsed.name === 'string' &&
      typeof parsed.kind === 'string' &&
      typeof parsed.mime === 'string'
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}
