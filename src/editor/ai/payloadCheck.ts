import { AI_FIELD_KEYS, AI_NODE_FIELDS } from './nodeFields'
import type { EntityTokenScope } from './entityFields'
import { branchOptionsError, nodeValueShapeError } from './patchShape'

/**
 * AI 入站写载荷的字段键与值形状校验（commands.ts 拆分）：create 的 data、
 * update 的 patch 共用同一序列，错误文案单点维护。字段协议在
 * nodeFields.ts，值形状细节在 patchShape.ts；本模块只负责
 * 「白名单 → 值形状 → 分支选项成员」的编排与目标类型未知时的全局键
 * 判定（含唯一归属 array 字段的恒非法容器校验，issue 67）。
 */

/** 节点类型 → 人读标签（错误文案与预览标签共用）。 */
export const NODE_TYPE_LABELS: Record<string, string> = {
  scene: '场景',
  beat: '节奏卡',
  dialogue: '对白',
  branch: '分支',
  shot: '分镜卡',
}

/** 全部可写节点类型字段的并集：目标类型未知时（update 经批次内 create
 * 的 ref）的全局键校验与白名单分类型校验的分界。 */
const ANY_NODE_FIELD_KEYS = new Set<string>(Object.values(AI_FIELD_KEYS).flat())

/** 唯一归属单个可写类型且协议为 array 的字段键（从协议表派生，不硬编码）：
 * 非数组值无论目标解析成哪个可写类型都恒非法——目标类型未知时可独立于
 * 类型解析点名（issue 67），与「任何节点类型都不支持的字段恒非法」同构。
 * 多类型共有字段（如 name/prompt）与唯一归属的非 array 字段不在此域：
 * 其形状判定依赖目标类型，仍分层延后到阶段 B。 */
const UNIQUE_ARRAY_FIELD_KEYS: ReadonlySet<string> = new Set(
  [
    ...Object.values(AI_NODE_FIELDS)
      .flat()
      .reduce((owners: Map<string, number>, spec) => {
        if (spec.type === 'array') owners.set(spec.key, (owners.get(spec.key) ?? 0) + 1)
        return owners
      }, new Map()),
  ].filter(([, count]) => count === 1).map(([key]) => key),
)

/** data/patch 字段白名单校验；返回错误文案或 null。无白名单条目的类型
 * 一律整批拒绝——如 §13 首版的图片节点（AI 命令暂不创建/修改，快照
 * 只读可见）：白名单缺失若放行，update_node 可携任意字段直抵画布
 * （prompt 注入对象后快照/生成即崩，畸形 outputs 落盘重开被静默修复）。 */
function checkFieldKeys(nodeType: string, fields: Record<string, unknown>): string | null {
  // issue 49：类型是外部字符串；继承属性既不是字段白名单，也不是人读标签。
  if (!Object.prototype.hasOwnProperty.call(AI_FIELD_KEYS, nodeType)) {
    return `${nodeType || '未知类型'} 暂不支持 AI 命令修改`
  }
  const allowed = AI_FIELD_KEYS[nodeType]
  const unknownKeys = Object.keys(fields).filter((k) => !allowed.includes(k))
  if (unknownKeys.length === 0) return null
  return `未知字段：${unknownKeys.join('、')}（${NODE_TYPE_LABELS[nodeType]} 允许：${allowed.join('、')}）`
}

/** 分类型写载荷校验（create 的 data 与 update 的 patch 共用同一序列）：
 * 字段键白名单 → 值形状 → 分支选项成员。entities（issue 44）：场景/对白
 * 的设定集结构化引用按实体快照解析。返回错误文案或 null。 */
export function payloadIssue(
  nodeType: string,
  fields: Record<string, unknown>,
  assets: ReadonlyMap<string, string>,
  entities?: EntityTokenScope,
): string | null {
  const keyError = checkFieldKeys(nodeType, fields)
  if (keyError) return keyError
  const shapeError = nodeValueShapeError(nodeType, fields, assets, entities)
  if (shapeError) return shapeError
  if (nodeType === 'branch' && Array.isArray(fields.options)) {
    return branchOptionsError(fields.options as unknown[])
  }
  return null
}

/** 目标类型未知时（update 经批次内 create 的 ref，或 token 被更早的
 * delete_node 点名、归属可经同名重建换主）的独立字段判定：任何可写
 * 节点类型都不支持的字段恒非法；唯一归属的 array 字段非数组值同属
 * 恒非法，同轮点名（issue 67）；其余类型专属的值形状错误随修复重放
 * 在阶段 B 点名（分层暴露）。返回错误文案或 null。 */
export function unknownTargetFieldIssue(patch: Record<string, unknown>): string | null {
  const globalUnknown = Object.keys(patch).filter((k) => !ANY_NODE_FIELD_KEYS.has(k))
  if (globalUnknown.length > 0) {
    return `未知字段：${globalUnknown.join('、')}（不是任何可写节点类型的字段）`
  }
  const badArrays = Object.entries(patch)
    .filter(([k, v]) => UNIQUE_ARRAY_FIELD_KEYS.has(k) && !Array.isArray(v))
    .map(([k]) => k)
  if (badArrays.length > 0) {
    return `载荷形状错误：${badArrays.join('、')} 须为数组`
  }
  return null
}
