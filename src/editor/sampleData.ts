import type { ProjectSettings } from './settings'

/**
 * 示例项目数据（docs/ui-design.md §5–§8）。
 * 设定集实体（角色/地点）随种子项目持久化；画布节点与左栏设定集
 * 分段经实体 id 引用同一份数据，改名/删除全局联动。
 */

/** 种子设定集：两位角色 + 三个地点。 */
export const LIN_WAN_ID = 'ch-linwan'
export const CHEN_MO_ID = 'ch-chenmo'
export const LOC_ROOFTOP_ID = 'loc-tiantai'
export const LOC_APARTMENT_ID = 'loc-jiugongyu'
export const LOC_STATION_ID = 'loc-chezhan'

export const SAMPLE_SETTINGS: ProjectSettings = {
  characters: [
    {
      id: LIN_WAN_ID,
      name: '林晚',
      gradient: 'linear-gradient(135deg,#e0176e,#7f6cf0)',
      bio: '悬疑作家，十年前父亲雨夜坠楼，一直在追查真相。',
    },
    {
      id: CHEN_MO_ID,
      name: '陈默',
      gradient: 'linear-gradient(135deg,#00b3d8,#5e5ce6)',
      bio: '林晚父亲的学生，知情却沉默十年，雨夜重返天台。',
    },
  ],
  locations: [
    { id: LOC_ROOFTOP_ID, name: '天台', note: '城市高层住宅天台 · 雨夜主场景' },
    { id: LOC_APARTMENT_ID, name: '旧公寓', note: '林晚父亲故居 · 昏黄钨丝灯' },
    { id: LOC_STATION_ID, name: '车站', note: '清晨站台 · 告别场景' },
  ],
}

/** 首页资产库六分类占位（docs/ui-design.md §8.1，跨项目个人库）。 */
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

export type { CharacterEntity, LocationEntity } from './settings'
