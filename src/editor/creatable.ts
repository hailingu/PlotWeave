/**
 * 可创建节点类型的注册表（docs/ui-design.md §3.3：＋节点下拉与空白菜单
 * 共用同一份清单：场景 / 节奏卡 / 对白 / 分支 / 分镜卡 / 图片节点）。
 * 独立成模块供标题栏、右键菜单、节点工厂与 AI 批量模拟器共同引用。
 */

/** ＋节点下拉的创建项（§3.3；图片节点为 §13 生成侧媒体节点）。 */
export const CREATABLE_TYPES = ['scene', 'beat', 'dialogue', 'branch', 'shot', 'image'] as const

/** 可创建节点类型字面量联合。 */
export type CreatableType = (typeof CREATABLE_TYPES)[number]

/** 创建项的人读标签（菜单展示用）。 */
export const CREATE_LABELS: Record<CreatableType, string> = {
  scene: '场景',
  beat: '节奏卡',
  dialogue: '对白',
  branch: '分支',
  shot: '分镜卡',
  image: '图片节点',
}
