/**
 * 设定集实体模型（docs/ui-design.md §5：设定集 ⇄ 节点双向可见）。
 * 节点只存实体 id、渲染时经 settings 解析——改设定集一处，
 * 全部节点引用同时生效；实体被删时节点按「失效引用」展示（§4.3），
 * 不自动清除（§8.2.3），撤销删除即恢复。
 *
 * 类型所有权（issue #353 方向一）：实体/桶类型、空集常量与归一化由
 * 磁盘格式所有者 src/model/settings.ts 单点定义，本模块再导出保持编辑器
 * 消费面稳定，并保留 UI 专属的创建（调色板/默认值）与解析（头像/名称）
 * 助手。
 */
import { newEntityId } from '../model/settings'
import type {
  CharacterEntity,
  DocumentEntity,
  LocationEntity,
  ProjectSettings,
} from '../model/settings'

export {
  EMPTY_SETTINGS,
  newEntityId,
  normalizeSettings,
  type CharacterEntity,
  type DocumentEntity,
  type LocationEntity,
  type PropEntity,
  type ProjectSettings,
} from '../model/settings'

/** 新增角色的默认头像渐变调色板（由实体 id 确定性派生取用）。 */
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg,#e0176e,#7f6cf0)',
  'linear-gradient(135deg,#00b3d8,#5e5ce6)',
  'linear-gradient(135deg,#30d158,#0a84ff)',
  'linear-gradient(135deg,#ff9f0a,#ff375f)',
  'linear-gradient(135deg,#bf5af2,#5e5ce6)',
  'linear-gradient(135deg,#64d2ff,#30d158)',
]

/**
 * 角色 id → 头像渐变（issue #395）：以 id 的确定性散列取调色板下标——
 * 工厂不持有跨调用共享游标，同一 id（撤销/重做重放或任意重放路径）
 * 恒得同一渐变，「新增角色」命令幂等可重放；条目分布由 id 的随机尾
 * 保证。id 首选散列（Java 风格 31 乘子）冲突只影响取相邻条目，无正确
 * 性含义。
 */
export function avatarGradientOf(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    // Math.imul 每轮按 int32 截断累积值，加数 ≤ 0x10FFFF，和恒在精确
    // 整数范围内，无需显式位截断
    hash = Math.imul(hash, 31) + (id.codePointAt(i) ?? 0)
  }
  // 调色板为模块级非空常量；?? 兜底只消解模运算下标的缺失分支（不可达）
  return (
    AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length] ??
    AVATAR_GRADIENTS[0] ??
    ''
  )
}

/** 新建角色实体（名字去空白；渐变由 id 确定性派生，issue #395）。 */
export function createCharacter(name: string): CharacterEntity {
  const id = newEntityId('ch')
  return { id, name: name.trim(), gradient: avatarGradientOf(id) }
}

/** 新建地点实体。 */
export function createLocation(name: string): LocationEntity {
  return { id: newEntityId('loc'), name: name.trim() }
}

/** 新建设定文档实体（issue 56）：标题去空白，正文与关联为空，
 * 由编辑器或 AI 写入通道填充。 */
export function createDocument(title = '新文档'): DocumentEntity {
  return {
    id: newEntityId('doc'),
    title: title.trim(),
    body: '',
    relatedIds: [],
  }
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
export function resolveCharacterName(
  settings: ProjectSettings,
  id: string,
): string | null {
  return settings.characters.find((c) => c.id === id)?.name ?? null
}

/** 地点 id → 名字；失效返回 null。 */
export function resolveLocationName(
  settings: ProjectSettings,
  id: string,
): string | null {
  return settings.locations.find((l) => l.id === id)?.name ?? null
}
