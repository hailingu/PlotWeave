/**
 * 类型化的节点字段补丁命令（issue 16：UI↔领域模型边界的类型收口）。
 * 所有面板编辑与 AI 批量更新都经「判别化补丁命令」落库：patch 与节点
 * type 一一绑定（NodeDataPatch），跨类型补丁（如把 scene 的字段打到
 * dialogue 节点）在编译期即拒绝，面板传错字段名/值类型不再静默直达画布。
 * 本模块是补丁路径唯一的宽化收口点：运行态合并（mergeNodeData）与
 * 受控构造（dataPatchOf/episodeNoPatch）在此背书，消费方不得自行 cast。
 */
import type {
  BeatNodeData,
  BranchNodeData,
  DialogueNodeData,
  ImageNodeData,
  SceneNodeData,
  ShotNodeData,
  CanvasNode,
} from './types'

/** 节点类型 → 运行态 data 形状的绑定表（与 types.ts 的 *NodeData 一一
 * 对应）；NodeDataPatch 按键集判别。 */
export interface NodeDataOf {
  scene: SceneNodeData
  beat: BeatNodeData
  dialogue: DialogueNodeData
  branch: BranchNodeData
  shot: ShotNodeData
  image: ImageNodeData
}

/** 按节点类型判别的字段补丁命令：`{ nodeType, patch }` 联合，patch 为该
 * 类型 data 的 Partial——补丁与目标节点的形状强绑定（issue 16）。 */
export type NodeDataPatch = {
  [T in keyof NodeDataOf]: { nodeType: T; patch: PatchShape<NodeDataOf[T]> }
}[keyof NodeDataOf]

/** 补丁形状：剥离 *NodeData 因 React Flow 泛型约束（Node<Data extends
 * Record<string, unknown>>，见 types.ts）继承的字符串索引签名，只保留
 * 显式字段——否则宽索引会让任意键的跨类型补丁绕过编译检查（issue 16）。 */
export type PatchShape<T> = Partial<ExplicitFields<T>>

/** 显式字段提取：key remapping 过滤索引签名键（string extends K 即索引键）。 */
type ExplicitFields<T> = {
  [K in keyof T as string extends K ? never : K]: T[K]
}

/** 运行态 data 字段合并（EditorView.applyDataPatch 与 AI 批量模拟共用）：
 * 逐键覆盖。联合展开的宽化收口于此——patch 已由 NodeDataPatch 与目标
 * 节点类型绑定，合并语义与历史行为一致（不校验、不剥离）。 */
export function mergeNodeData(n: CanvasNode, patch: Record<string, unknown>): CanvasNode {
  return { ...n, data: { ...n.data, ...patch } } as CanvasNode
}

/** 受控构造出口：已校验的运行态补丁 → 判别命令。两个使用方的 patch 都
 * 先于本调用完成形状背书——undo 快照的键集与原补丁一致（值即被替换键
 * 的原值）、AI 校验器已完成键白名单与值形状校验（§9.3）、episodeNo
 * 补丁的字段即为全量内容；泛型关联无法被 TS 证明，cast 收口于此，
 * 调用点不得散布裸转换。 */
export function dataPatchOf(nodeType: keyof NodeDataOf, patch: Record<string, unknown>): NodeDataPatch {
  return { nodeType, patch } as NodeDataPatch
}

/** episodeNo 补丁（§3.5 分集）：可分集的编剧侧四类按节点类型分派——
 * 大纲拖拽跨组改集归属的唯一补丁形态；分镜卡随宿主场景分集、图片节点
 * 非叙事单元，均不出此补丁（调用方先行排除）。四类 data 均含可选
 * episodeNo，同构构造经受控出口完成绑定。 */
export function episodeNoPatch(
  nodeType: 'scene' | 'beat' | 'dialogue' | 'branch',
  episodeNo: number | undefined,
): NodeDataPatch {
  return dataPatchOf(nodeType, { episodeNo })
}
