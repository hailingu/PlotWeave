import { AI_FIELD_KEYS } from './nodeFields'
import { branchOptionsError, nodeValueShapeError } from './patchShape'

/**
 * AI 入站写载荷的字段键与值形状校验（commands.ts 拆分）：create 的 data、
 * update 的 patch 与 contingent 路径的暂定类型校验共用同一序列，错误文案
 * 单点维护。字段协议在 nodeFields.ts，值形状细节在 patchShape.ts；本模块
 * 只负责「白名单 → 值形状 → 分支选项成员」的编排与暂定类型的独立判定。
 */

/** 节点类型 → 人读标签（错误文案与预览标签共用）。 */
export const NODE_TYPE_LABELS: Record<string, string> = {
  scene: '场景',
  beat: '节奏卡',
  dialogue: '对白',
  branch: '分支',
  shot: '分镜卡',
}

/** 全部可写节点类型字段的并集：update 载荷的全局键校验（contingent 路径
 * 也适用的独立判定）与白名单分类型校验的分界。 */
const ANY_NODE_FIELD_KEYS = new Set<string>(Object.values(AI_FIELD_KEYS).flat())

/** data/patch 字段白名单校验；返回错误文案或 null。无白名单条目的类型
 * 一律整批拒绝——如 §13 首版的图片节点（AI 命令暂不创建/修改，快照
 * 只读可见）：白名单缺失若放行，update_node 可携任意字段直抵画布
 * （prompt 注入对象后快照/生成即崩，畸形 outputs 落盘重开被静默修复）。 */
function checkFieldKeys(nodeType: string, fields: Record<string, unknown>): string | null {
  const allowed = AI_FIELD_KEYS[nodeType]
  if (!allowed) {
    return `${NODE_TYPE_LABELS[nodeType] ?? (nodeType || '未知类型')} 暂不支持 AI 命令修改`
  }
  const unknownKeys = Object.keys(fields).filter((k) => !allowed.includes(k))
  if (unknownKeys.length === 0) return null
  return `未知字段：${unknownKeys.join('、')}（${NODE_TYPE_LABELS[nodeType]} 允许：${allowed.join('、')}）`
}

/** 分类型写载荷校验（create 的 data 与 update 的 patch 共用同一序列）：
 * 字段键白名单 → 值形状 → 分支选项成员。返回错误文案或 null。 */
export function payloadIssue(
  nodeType: string,
  fields: Record<string, unknown>,
  assets: ReadonlyMap<string, string>,
): string | null {
  const keyError = checkFieldKeys(nodeType, fields)
  if (keyError) return keyError
  const shapeError = nodeValueShapeError(nodeType, fields, assets)
  if (shapeError) return shapeError
  if (nodeType === 'branch' && Array.isArray(fields.options)) {
    return branchOptionsError(fields.options as unknown[])
  }
  return null
}

/** contingent update 的载荷独立判定（目标尚未入虚拟图）：任何节点类型都
 * 不支持的字段恒非法；失败 create 已登记暂定类型时再按该类型的完整写载荷
 * 序列校验——修正 data 不改变已声明的类型语义，这些错误即使 create 修复后
 * 仍然存在。返回错误文案或 null。 */
export function contingentUpdateIssue(
  nodeType: string | undefined,
  patch: Record<string, unknown>,
  assets: ReadonlyMap<string, string>,
): string | null {
  if (nodeType === undefined) {
    const globalUnknown = Object.keys(patch).filter((k) => !ANY_NODE_FIELD_KEYS.has(k))
    return globalUnknown.length > 0
      ? `未知字段：${globalUnknown.join('、')}（不是任何可写节点类型的字段）`
      : null
  }
  return payloadIssue(nodeType, patch, assets)
}
