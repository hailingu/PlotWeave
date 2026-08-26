import type { NodeAvatar } from './nodes/types'

/**
 * 示例项目数据（docs/ui-design.md §5–§8）。
 * 画布节点与左栏「设定集 / 资产」分段共用同一份示例：
 * 持久化落地后由 Rust 端 ProjectDocument 派生视图替换。
 */

/** 示例角色头像（占位期直接存渐变串，后续由设定集头像派生）。 */
export const LIN_WAN: NodeAvatar = {
  label: '晚',
  gradient: 'linear-gradient(135deg,#e0176e,#7f6cf0)',
}
export const CHEN_MO: NodeAvatar = {
  label: '默',
  gradient: 'linear-gradient(135deg,#00b3d8,#5e5ce6)',
}

/** 设定集 · 角色条目：头像 + 名称 + 一句小传（结构占位，编辑随后续任务）。 */
export interface SettingCharacter {
  name: string
  avatar: NodeAvatar
  bio: string
}

export const SAMPLE_CHARACTERS: SettingCharacter[] = [
  { name: '林晚', avatar: LIN_WAN, bio: '悬疑作家，十年前父亲雨夜坠楼，一直在追查真相。' },
  { name: '陈默', avatar: CHEN_MO, bio: '林晚父亲的学生，知情却沉默十年，雨夜重返天台。' },
]

/** 设定集 · 地点条目（对应索引卡的 locationId，占位期存展示名）。 */
export interface SettingLocation {
  name: string
  note: string
}

export const SAMPLE_LOCATIONS: SettingLocation[] = [
  { name: '天台', note: '城市高层住宅天台 · 雨夜主场景' },
  { name: '旧公寓', note: '林晚父亲故居 · 昏黄钨丝灯' },
  { name: '车站', note: '清晨站台 · 告别场景' },
]

/** 资产库 · 美术部门六分类（docs/ui-design.md §8.1，跨项目个人库）。 */
export interface AssetCategory {
  kind: string
  label: string
  icon: string
  count: number
}

export const ASSET_CATEGORIES: AssetCategory[] = [
  { kind: 'character', label: '角色设定', icon: '👤', count: 2 },
  { kind: 'location', label: '场景设定', icon: '🏞', count: 3 },
  { kind: 'wardrobe', label: '服化道', icon: '🧥', count: 0 },
  { kind: 'colorlight', label: '色彩光影', icon: '🎨', count: 1 },
  { kind: 'reference', label: '风格参考', icon: '🖼', count: 4 },
  { kind: 'other', label: '其他', icon: '📦', count: 0 },
]
