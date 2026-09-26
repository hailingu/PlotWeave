/**
 * 会话设定集形状与实体身份（issue #353 方向一）：会话文档 settings 的
 * 实体/桶类型与归一化由磁盘格式所有者 src/model/ 定义（docs/data-model.md
 * §6），编辑器侧（src/editor/settings.ts）再导出并保留 UI 专属的创建/
 * 解析助手，不构成 model → editor 的反向引用。
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
  /** 关联的 Character / Location 条目：kind + id 显式成对（§6）。 */
  relatedIds: Array<{ kind: 'character' | 'location'; id: string }>
}

/** 项目设定集：随会话文档与 ProjectDocument 持久化。props/documents
 * 首版只透传不编辑。 */
export interface ProjectSettings {
  characters: CharacterEntity[]
  locations: LocationEntity[]
  props?: PropEntity[]
  documents?: DocumentEntity[]
}

/** 空设定集常量：新建项目与无设定快照的缺省值；消费方不得就地进行
 * 数组改写（共享引用）。 */
export const EMPTY_SETTINGS: ProjectSettings = { characters: [], locations: [] }

/** 新实体 id：类型前缀 + 时间戳 36 进制 + 随机尾（同毫秒防碰撞）。
 * 前缀随桶扩展（ch/loc/prop/doc），调用方按域选用。 */
export function newEntityId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
}

/** 项目文档缺省合并：旧文件无 settings 或字段缺失时补空集（向后兼容）。
 * props/documents 为契约透传桶：存在即原样保留（漏带即保存/迁移回写丢失）。 */
export function normalizeSettings(raw: unknown): ProjectSettings {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_SETTINGS }
  const obj = raw as Partial<ProjectSettings>
  return {
    characters: Array.isArray(obj.characters) ? obj.characters : [],
    locations: Array.isArray(obj.locations) ? obj.locations : [],
    ...(Array.isArray(obj.props) ? { props: obj.props } : {}),
    ...(Array.isArray(obj.documents) ? { documents: obj.documents } : {}),
  }
}
