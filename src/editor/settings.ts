/**
 * 设定集实体模型（docs/ui-design.md §5：设定集 ⇄ 节点双向可见）。
 * 节点只存实体 id、渲染时经 settings 解析——改设定集一处，
 * 全部节点引用同时生效；实体被删时节点按「失效引用」展示（§4.3），
 * 不自动清除（§8.2.3），撤销删除即恢复。
 */

/** 角色实体：项目内设定集条目。 */
export interface CharacterEntity {
  id: string
  name: string
  /** 头像渐变（新增时从调色板轮转取用）。 */
  gradient: string
  /** 一句小传（可选）。 */
  bio?: string
}

/** 地点实体：对应索引卡的地点引用。 */
export interface LocationEntity {
  id: string
  name: string
  note?: string
}

/** 道具实体：契约桶（数据模型 §6）。首版 UI 未开放道具编辑，
 * 会话仅透传保真——漏带即保存丢实体。 */
export interface PropEntity {
  id: string
  name: string
  description?: string
}

/** 设定文档实体：长篇自由文本（人物小传/世界观/术语表，数据模型 §6）。
 * 首版 UI 未开放编辑，会话仅透传保真——漏带即保存丢文档。 */
export interface DocumentEntity {
  id: string
  title: string
  body: string
  /** 关联的 Character / Location id。 */
  relatedIds: string[]
}

/** 项目设定集：随 ProjectDocument 持久化。props/documents 首版只透传不编辑。 */
export interface ProjectSettings {
  characters: CharacterEntity[]
  locations: LocationEntity[]
  props?: PropEntity[]
  documents?: DocumentEntity[]
}

export const EMPTY_SETTINGS: ProjectSettings = { characters: [], locations: [] }

/** 新增角色/地点的默认头像渐变调色板（轮转取用）。 */
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg,#e0176e,#7f6cf0)',
  'linear-gradient(135deg,#00b3d8,#5e5ce6)',
  'linear-gradient(135deg,#30d158,#0a84ff)',
  'linear-gradient(135deg,#ff9f0a,#ff375f)',
  'linear-gradient(135deg,#bf5af2,#5e5ce6)',
  'linear-gradient(135deg,#64d2ff,#30d158)',
]

let paletteCursor = 0

/** 新实体 id：类型前缀 + 时间戳 36 进制 + 随机尾（同毫秒防碰撞）。 */
export function newEntityId(prefix: 'ch' | 'loc'): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
}

/** 新建角色实体（名字去空白；渐变从调色板轮转）。 */
export function createCharacter(name: string): CharacterEntity {
  const gradient = AVATAR_GRADIENTS[paletteCursor++ % AVATAR_GRADIENTS.length]
  return { id: newEntityId('ch'), name: name.trim(), gradient }
}

/** 新建地点实体。 */
export function createLocation(name: string): LocationEntity {
  return { id: newEntityId('loc'), name: name.trim() }
}

/** 头像单字标签：取名字首字符。 */
function avatarLabel(name: string): string {
  return name.trim().charAt(0) || '?'
}

/** 角色 id → 头像派生视图；失效（实体已删）返回 null，由调用方按失效引用渲染。 */
export function resolveCharacterAvatar(
  settings: ProjectSettings,
  id: string,
): { label: string; gradient: string } | null {
  const entity = settings.characters.find((c) => c.id === id)
  if (!entity) return null
  return { label: avatarLabel(entity.name), gradient: entity.gradient }
}

/** 角色 id → 名字；失效返回 null。 */
export function resolveCharacterName(settings: ProjectSettings, id: string): string | null {
  return settings.characters.find((c) => c.id === id)?.name ?? null
}

/** 地点 id → 名字；失效返回 null。 */
export function resolveLocationName(settings: ProjectSettings, id: string): string | null {
  return settings.locations.find((l) => l.id === id)?.name ?? null
}

/** 项目文档缺省合并：旧文件无 settings 或字段缺失时补空集（向后兼容）。
 * documents 为契约透传桶：存在即原样保留（漏带即保存丢文档）。 */
export function normalizeSettings(raw: unknown): ProjectSettings {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_SETTINGS }
  const obj = raw as Partial<ProjectSettings>
  return {
    characters: Array.isArray(obj.characters) ? obj.characters : [],
    locations: Array.isArray(obj.locations) ? obj.locations : [],
    ...(Array.isArray(obj.documents) ? { documents: obj.documents } : {}),
  }
}
