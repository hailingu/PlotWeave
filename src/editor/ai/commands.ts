import type { NodeDataPatch } from '../nodes/patch'

/**
 * AI 批量命令的解析与校验（docs/ui-design.md §6 改动预览卡、数据模型 §12）。
 *
 * 核心约束：Agent 只产出命令，写操作执行前必须整批预览；任一条非法即
 * 整批拒绝（预览卡 = 一个 batch 命令，执行后一步撤销）。本模块是纯函数：
 * 输入模型的回复文本与画布快照，输出可直接渲染的预览条目与待执行命令，
 * 不触碰任何 React 状态。
 *
 * 职责分工（issue 39）：本文件是契约层——命令/校验结果的类型、入站↔执行
 * 形态转换；从助手回复文本提取批次对象的解析在 batchText.ts（围栏回退
 * 通道）；逐条折叠校验的实现域在 batchFold.ts，validateAiBatch 经此
 * re-export，引用方保持单一入口；模拟执行在 batchSim.ts。
 */

/** 模型可产出的五类命令（对齐数据模型 §12.2 写工具集的首版子集）。
 * 这是**入站**信任边界的形态：update_node 的 patch 是模型自报的
 * Record，合法性与目标节点类型的绑定由 validateAiBatch 校验（§9.3），
 * 校验通过后以 ValidatedCommand 进入执行通道（issue 16）。 */
export type AiCommand =
  | { op: 'create_node'; nodeType: string; ref?: unknown; data?: unknown; reason?: unknown }
  | { op: 'update_node'; nodeId: string; patch: Record<string, unknown>; reason?: unknown }
  | { op: 'delete_node'; nodeId: string; reason?: unknown }
  | {
      op: 'connect_edge'
      sourceId: string
      targetId: string
      /** 连线语义（§4.4）：缺省为剧情流。 */
      edgeKind?: unknown
      /** edgeKind = branch 时的选项下标（0 基，必须在分支选项范围内）。 */
      optionIndex?: unknown
      reason?: unknown
    }
  | { op: 'disconnect_edge'; sourceId: string; targetId: string; reason?: unknown }

/** 校验通过的执行命令（BatchValidation.commands → applyAiBatch →
 * simulateBatch 的形态）：与入站 AiCommand 同构，唯一差别是 update_node
 * 的 patch 已按目标节点类型完成键白名单与值形状校验并判别化绑定
 * NodeDataPatch（issue 16）——执行与撤销路径不再接受宽 Record 补丁。 */
export type ValidatedCommand =
  | Extract<AiCommand, { op: 'create_node' | 'delete_node' | 'connect_edge' | 'disconnect_edge' }>
  | (Omit<Extract<AiCommand, { op: 'update_node' }>, 'patch'> & { patch: NodeDataPatch })

/** 执行命令 → 入站形态（applyAiBatch 重校验用）：判别补丁剥回模型侧的
 * 宽 Record——validateAiBatch 的契约是入站信任边界，目标节点类型必须
 * 对当前画布快照重推导（预览与确认之间画布可能变化），wrapper 的
 * nodeType 只是编译期绑定，重校验不消费。剥壳无信息丢失（patch 本体
 * 原样回交）。 */
export function toInboundCommands(batch: ValidatedCommand[]): AiCommand[] {
  return batch.map((cmd) => {
    if (cmd.op !== 'update_node') return cmd
    return {
      op: 'update_node',
      nodeId: cmd.nodeId,
      patch: cmd.patch.patch as Record<string, unknown>,
      ...(cmd.reason !== undefined ? { reason: cmd.reason } : {}),
    }
  })
}

/** 校验所需的压缩图快照：节点 id/类型/人读标签、现有边端点与端口。 */
export interface AiGraphSnapshot {
  nodes: Array<{
    id: string
    type: string
    label: string
    /** branch 节点必填：选项（id + 文案），branch 连线的 optionIndex 校验与端口 id 解析用。 */
    options?: Array<{ id: string; label: string }>
  }>
  edges: Array<{ source: string; target: string; sourceHandle?: string | null; type?: string }>
  /** 项目资产索引（id → MIME）：shot.refs 引用位的资产存在性与用途匹配校验
   * （§7.1/§11.3 的批命令对等）。空索引 = 无资产，引用位一律拒绝。 */
  assets: ReadonlyMap<string, string>
}

/** 预览卡的单行条目（§6：逐项列出受影响节点与变更类型）。 */
export interface PreviewItem {
  kind: 'delete' | 'disconnect' | 'create' | 'update' | 'connect'
  danger: boolean
  label: string
  /** 渲染 key = 来源命令序号（折叠时注入，排序后仍唯一稳定）。 */
  key: string
}

export interface BatchIssue {
  index: number
  message: string
}

export interface BatchValidation {
  /** false = 整批拒绝（原子性：不允许只执行一半）。 */
  ok: boolean
  /** 展示顺序：删除类置顶（§6 危险操作置顶），其余保持命令顺序。 */
  items: PreviewItem[]
  /** 待执行命令：已校验的合法子集，原始顺序（执行语义必须按序折叠）。 */
  commands: ValidatedCommand[]
  issues: BatchIssue[]
  /** 删除类或级联断线（danger）在预览中：置顶展示并要求二次确认（§6）。 */
  hasDeletes: boolean
}

export { validateAiBatch } from './batchFold'
