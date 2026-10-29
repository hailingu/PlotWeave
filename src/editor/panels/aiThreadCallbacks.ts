import type {
  AiCommand,
  BatchValidation,
  ValidatedCommand,
  AiBatchConfirmation,
} from '../ai/commands'

/** 编辑器交给 AI 会话的能力契约；领域聚合允许省略，显式 undefined 不是已接线能力。 */
export interface AiThreadCallbacks {
  /** 校验文本中的命令批次；纯讨论返回 null。 */
  readonly onValidateAi?: (text: string) => BatchValidation | null
  /** 校验工具调用映射出的命令数组。 */
  readonly onValidateCommands?: (
    commands: AiCommand[],
  ) => BatchValidation | null
  /** 按稳定节点 id 读取 JSON，不存在返回 null。 */
  readonly onReadNode?: (nodeId: string) => string | null
  /** 读取设定集快照 JSON。 */
  readonly onReadSettings?: () => string
  /** 按文档 id 读取全文 JSON，不存在返回 null。 */
  readonly onReadDocument?: (documentId: string) => string | null
  /** 按名称查找节点与关联边，保留分页位置和游标。 */
  readonly onFindNodes?: (
    query: string,
    offset?: number,
    cursor?: string,
  ) => string
  /** 已确认批次作为单一复合命令执行；错误返回文案，成功返回 null。 */
  readonly onApplyAiBatch?: (
    commands: ValidatedCommand[],
    confirmation?: AiBatchConfirmation,
  ) => string | null
}

/** React/回合层转发可选成员时允许显式 undefined = 未接线；不放宽领域聚合的缺省约束。 */
export type ForwardedAiThreadCallbacks = {
  readonly [Key in keyof AiThreadCallbacks]?: AiThreadCallbacks[Key] | undefined
}
