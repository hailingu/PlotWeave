/**
 * 落盘图语义的单点定义（issue #353 方向一）：端口字面量、选项句柄编码与
 * 连线语义判别是磁盘格式（docs/data-model.md §4.3/§5）的一部分，所有权在
 * src/model/；编辑器侧（src/editor/graphRules.ts）再导出以对接交互规则，
 * 不构成 model → editor 的反向引用。
 */

/** 索引卡底部端口：attach 下挂分镜卡（§4.4 垂直 = 派生从属）。 */
export const SCENE_SHOT_HANDLE = 'shots'

/** 分支选项出口端口前缀：option-<选项 id>。绑定稳定 id 而非数组下标，
 * 删除任一选项不会位移其余出口的连线归属（docs/data-model.md §4.2/§5）。 */
export const BRANCH_OPTION_HANDLE_PREFIX = 'option-'

/** 选项 id → 出口端口名（option-<id>）：连线与句柄改写的统一构造器，
 * 消费方不得手拼前缀（口径与 BRANCH_OPTION_HANDLE_PREFIX 单点维护）。 */
export function branchOptionHandle(optionId: string): string {
  return `${BRANCH_OPTION_HANDLE_PREFIX}${optionId}`
}

/** 逆解析端口名中的选项 id；非选项端口返回 undefined。
 * JSON 边界会擦除类型（句柄可能是数字/对象），非字符串一律视为非选项端口，
 * 不得对非字符串调用字符串方法。 */
export function branchOptionIdOf(handle?: string | null): string | undefined {
  if (typeof handle !== 'string') return undefined
  if (!handle.startsWith(BRANCH_OPTION_HANDLE_PREFIX)) return undefined
  return handle.slice(BRANCH_OPTION_HANDLE_PREFIX.length)
}

/** 连线语义（§4.4）：横向剧情流 / 分支选项出口 / 分镜下挂。 */
export type EdgeKind = 'sequence' | 'branch' | 'attach'

/** 按边的运行态字段归类连线语义；未知形态一律按剧情流处理。
 * 输入是最小结构形状（type/className/sourceHandle），兼容会话边与
 * React Flow Edge——判别规则与落盘 data.kind 一一对应（§5）。 */
export function edgeKindOf(e: {
  // 可选成员显式含 undefined（issue #231）：JSON 边界擦除类型后的形态
  type?: string | undefined
  className?: string | undefined
  sourceHandle?: string | null | undefined
}): EdgeKind {
  if (e.type === 'branch') return 'branch'
  if (e.sourceHandle === SCENE_SHOT_HANDLE || e.className === 'pw-edge-attach')
    return 'attach'
  return 'sequence'
}
