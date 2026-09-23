import { llmChat, type AssistantMessage, type ChatMessage } from './chat'
import {
  claimsActionPreview,
  expectsActionPreview,
  needsActionRewrite,
} from './actionIntent'
import { rewriteActionQuery } from './queryRewrite'
import { extractBatchJson } from './batchText'
import { GRAPH_DIGEST_MAX_CHARS } from './graphDigest'
import {
  batchIssueText,
  type AiCommand,
  type BatchValidation,
} from './commands'
import {
  AI_TOOLS,
  toolCallsShapeDiagnostic,
  toolCallsToCommands,
  type ReadRequest,
  type ToolCall,
  type ToolCallParse,
} from './tools'
import type { ProviderConfig } from '../../settings/types'

/**
 * Agent 会话循环（数据模型 §12.2 朴素 tool-calling，issue 41 校验闭环）：
 * 含糊请求先经一次 query 改写归一化判定动作意图（#91，失败回退词表，
 * 不占读写预算）；读工具就地执行回喂后重问（≤ READ_ROUNDS 轮）；写命
 * 令交给调用方整批校验，未通过且未耗尽重试预算时把具体校验错误回喂
 * 模型（tool-calling 通道按协议逐调用应答，```json 围栏通道以 user 消
 * 息回喂），产出共 ≤ WRITE_ATTEMPTS 次；明确修改却无批次、解析失败也
 * 共享此预算（#75）。通过、耗尽或纯讨论即终止。重试只发生在对话层，
 * 画布零副作用——批次仍须用户在预览卡确认后才执行。
 * 纯编排模块：不触碰 React 状态，llmChat 是唯一 I/O。
 */

/** 读工具就地回喂的最大轮数（§12.2 低轮次约束）。 */
const READ_ROUNDS = 3
/** 写批次的最多产出次数：首次 + 3 次纠错重试（owner 定的 quota=3；每次
 * 重写消耗 1 次重试，3 次后仍失败即彻底失败）。 */
const WRITE_ATTEMPTS = 4
const READ_LIMIT_MESSAGE =
  '读取轮数已达上限，请使用已有信息；信息不足时请向用户澄清。'
const FIND_NODES_BUDGET_MESSAGE =
  '本轮 find_nodes 读取预算不足，未返回本次结果；请缩小查询，或在下一次用户请求中继续读取。'
const MISSING_BATCH_FEEDBACK =
  '本轮没有可确认的合法改动批次，操作说明不能代替预览。' +
  '若用户要求修改且信息足够，请参照系统提示中的完整批次示例和工具参数 schema，' +
  '通过写工具或完整 JSON 围栏输出全部命令及必要关联；' +
  '如信息不足，请明确询问缺少的目标或内容；如不支持，请说明限制。不要猜测目标，不要声称已执行或已有预览。'

/** 会话循环的最终产出：最后一轮的文本、解析错误与整批校验结果。 */
export interface AgentLoopResult {
  /** 最后一轮助手文本（围栏批次可能仍在其中，展示侧负责剥除）。 */
  prose: string
  /** 工具参数解析失败清单（面向用户上屏的文案）。 */
  toolErrors: string[]
  /** 最后一轮写批次的校验结果；null = 无批次，是否交付失败另看 completionError。 */
  validation: BatchValidation | null
  /** 无可用预览时的应用诊断，展示侧附入同一助手消息，随历史保存。 */
  completionError?: string
}

/** 双通道整批校验（由面板接线到 useAiBridge 的校验回调族）。 */
export interface BatchValidators {
  /** tool-calling 通道：命令数组校验；未接线视为不通过信息缺失（null）。
   * 可显式 undefined = 未接线（issue #231）。 */
  commands?: ((cmds: AiCommand[]) => BatchValidation | null) | undefined
  /** 围栏通道：回复文本批次校验；无批次（纯讨论）返回 null。 */
  prose?: ((text: string) => BatchValidation | null) | undefined
}

/** 读工具执行器签名：同步返回回喂文本（读工具就地执行，不进命令通道）。 */
export type ReadToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => string

/** 取消信号（issue #154）：协作式——runAgentLoop 在各检查点调用 isCancelled，
 * 返回 true 即停止后续循环并抛出 TurnCancelledError；调用方据此刻「已取消」
 * 并忽略本回合迟到结果。在途的这一次 llm_chat 请求不被中止（owner 裁决：
 * 仅停止循环），会继续跑完，其结果随回合一起被丢弃。 */
export interface TurnCancelSignal {
  isCancelled(): boolean
}

/** 回合被取消时抛出的可判别错误：调用方据此产出取消回执而非错误横幅。 */
export class TurnCancelledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'TurnCancelledError'
  }
}

/** 取消检查点：置位即抛出，停止后续循环（含读回喂与纠错重试）。 */
function throwIfCancelled(signal: TurnCancelSignal | undefined): void {
  if (signal?.isCancelled()) throw new TurnCancelledError()
}

/** 一次 Agent 回合内共享 find_nodes 回喂预算，拒绝超额结果而不伪装成完整页。 */
function withFindNodesBudget(readTool: ReadToolExecutor): ReadToolExecutor {
  let remaining = GRAPH_DIGEST_MAX_CHARS
  return (name, args) => {
    if (name !== 'find_nodes') return readTool(name, args)
    if (remaining === 0) return FIND_NODES_BUDGET_MESSAGE
    const result = readTool(name, args)
    if (result.length > remaining) return FIND_NODES_BUDGET_MESSAGE
    remaining -= result.length
    return result
  }
}

/** 校验失败清单的人读文本（回喂与上屏共用同一编号口径，issue #150 起
 * 经 batchIssueText 格式化：批次级整体错误不编「第 N 条」序号）。 */
function issueListText(v: BatchValidation): string {
  return v.issues.map((i) => batchIssueText(i)).join('\n')
}

/** 读结果与交付失败共用协议回喂：逐调用应答，文本通道以 assistant + user
 * 对回喂；调用方负责读取预算，耗尽时以诊断代替实际读取。 */
function pushFeedback(
  messages: ChatMessage[],
  calls: ToolCall[],
  prose: string,
  errorText: string,
  readTool: ReadToolExecutor,
  reads: ReadRequest[],
): void {
  if (calls.length > 0) {
    messages.push({ role: 'assistant', content: prose, tool_calls: calls })
    const readById = new Map(reads.map((r) => [r.id, readTool(r.name, r.args)]))
    for (const c of calls) {
      messages.push({
        role: 'tool',
        tool_call_id: c.id,
        content: readById.get(c.id) ?? errorText,
      })
    }
    // 围栏错误可能与纯读工具同轮出现；每个读调用仍须收到真实结果，
    // 另附纠正消息，不能因没有写调用可承载错误而吞掉整批诊断。
    if (errorText && calls.length === reads.length)
      messages.push({ role: 'user', content: errorText })
    return
  }
  messages.push(
    { role: 'assistant', content: prose },
    { role: 'user', content: errorText },
  )
}

/** 通道解析也是整批边界，任一工具错误不能被其他合法命令或围栏掩盖。 */
function validateReply(
  parsed: ToolCallParse,
  prose: string,
  validators: BatchValidators,
): BatchValidation | null {
  if (parsed.errors.length > 0) {
    return {
      ok: false,
      commands: [],
      items: [],
      hasDeletes: false,
      issues: parsed.errors.map((message, index) => ({ index, message })),
    }
  }
  const validation =
    parsed.commands.length > 0
      ? (validators.commands?.(parsed.commands) ?? null)
      : (validators.prose?.(prose) ?? null)
  if (
    validation?.ok &&
    validation.commands.length === 0 &&
    extractBatchJson(prose)?.commands.length === 0
  ) {
    return {
      ...validation,
      ok: false,
      issues: [{ index: 0, message: '批次没有任何改动命令。' }],
    }
  }
  return validation
}

/** 区分已有校验诊断与无批次交付，保留完整批次纠正要求和澄清出口。 */
function correctionText(result: AgentLoopResult): string | null {
  const v = result.validation
  if (v && !v.ok) {
    return (
      `你给出的改动批次未通过校验：\n${issueListText(v)}\n` +
      '请逐条修正上述错误后重新输出完整批次（涉及字段时只使用字段表中该类型的合法字段），未被点名的命令保持原样。'
    )
  }
  return result.completionError
    ? `${result.completionError}\n${MISSING_BATCH_FEEDBACK}`
    : null
}

/** 汇总一次产出的校验结果；已期待写方案却无批次时附上同轮交付诊断。 */
function resultForReply(
  parsed: ToolCallParse,
  prose: string,
  validation: BatchValidation | null,
  expectsPreview: boolean,
  readsOnly: boolean,
): AgentLoopResult {
  const result: AgentLoopResult = {
    prose,
    toolErrors: parsed.errors,
    validation,
  }
  if (validation === null && (expectsPreview || readsOnly)) {
    const reason =
      parsed.commands.length > 0
        ? '当前没有可用的批次校验结果。'
        : '模型没有返回可解析的非空改动批次。'
    result.completionError =
      `本轮未生成可执行改动，未执行本轮操作，也没有可确认的预览卡。${readsOnly ? READ_LIMIT_MESSAGE : reason}` +
      '请补充目标节点或具体改动后重试；若回复在询问信息，请先回答该问题。'
  }
  return result
}

/** 信任边界形状守卫的中止结果（#127 所有者裁决）：tool_calls 外壳畸形
 * 是 provider 协议故障而非模型可修正错误——纠错回喂是面向模型的修正
 * 指令，外壳错误模型无力修正且重试大概率原样失败、空烧预算；以
 * completionError 结构化诊断（展示侧 ⚠ 前缀随历史保存）直接结束本轮。
 * 外壳合法后的内容级错误（坏 JSON 参数、未知工具名）不在此列。 */
function shapeAbortResult(reply: AssistantMessage): AgentLoopResult | null {
  const shapeError = toolCallsShapeDiagnostic(reply.tool_calls)
  if (shapeError === null) return null
  return {
    prose: (reply.content ?? '').trim(),
    toolErrors: [],
    validation: null,
    completionError:
      `本轮中止：模型服务返回的 tool_calls 结构非法（${shapeError}）。` +
      '这属于 provider 兼容性问题，自动重试无法修正；' +
      '请检查所选 provider 的 OpenAI 兼容性，或调整后重新发送。',
  }
}

/** 初始动作意图预判（#91）：词表先行；含糊输入经一次改写归一化补充
 * 判定——改写回复按整回复校验后才采信，失败或非规范回复回退词表结果，
 * 回合照常进行；改写不占读写预算。返回是否期待写方案预览。 */
async function expectsPreviewWithRewrite(
  provider: ProviderConfig,
  model: string,
  initialText: string,
): Promise<boolean> {
  let expects = expectsActionPreview(initialText)
  if (needsActionRewrite(initialText)) {
    const rewritten = await rewriteActionQuery(provider, model, initialText)
    expects ||= rewritten !== null
  }
  return expects
}

/** 朴素 tool-calling 循环：messages 原地追加，返回最后一轮结果。 */
export async function runAgentLoop(
  provider: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  readTool: ReadToolExecutor,
  validators: BatchValidators,
  signal?: TurnCancelSignal,
): Promise<AgentLoopResult> {
  let readRounds = 0
  let writeAttempts = 0
  const budgetedRead = withFindNodesBudget(readTool)
  const initialText =
    [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  // 取消点：改写归一化也消耗一次请求——用户在改写期间取消应同样生效
  throwIfCancelled(signal)
  let expectsPreview = await expectsPreviewWithRewrite(
    provider,
    model,
    initialText,
  )
  let result: AgentLoopResult = { prose: '', toolErrors: [], validation: null }
  for (let round = 0; round < READ_ROUNDS + WRITE_ATTEMPTS; round++) {
    throwIfCancelled(signal)
    const reply: AssistantMessage = await llmChat(
      provider,
      model,
      messages,
      AI_TOOLS,
    )
    // 取消点：在途请求落定后、消费其产出前检查——取消优先于形状中止/纠错
    throwIfCancelled(signal)
    // 形状错误结构化中止（#127 所有者裁决）：不进纠错、零回喂
    const aborted = shapeAbortResult(reply)
    if (aborted !== null) return aborted
    const calls: ToolCall[] = reply.tool_calls ?? []
    const parsed = toolCallsToCommands(calls)
    const { readRequests, errors } = parsed
    const prose = (reply.content ?? '').trim()
    const validation = validateReply(parsed, prose, validators)
    const attempted =
      calls.length > readRequests.length ||
      validation !== null ||
      /"commands"\s*:/.test(prose)
    expectsPreview ||= attempted || claimsActionPreview(prose)
    const readsOnly =
      !attempted && errors.length === 0 && readRequests.length > 0
    if (readsOnly && readRounds < READ_ROUNDS) {
      readRounds += 1
      pushFeedback(messages, calls, prose, '', budgetedRead, readRequests)
      continue
    }
    result = resultForReply(
      parsed,
      prose,
      validation,
      expectsPreview,
      readsOnly,
    )
    writeAttempts += 1
    const feedback = correctionText(result)
    if (feedback === null || writeAttempts >= WRITE_ATTEMPTS) break
    const boundedRead =
      readRounds < READ_ROUNDS ? budgetedRead : () => READ_LIMIT_MESSAGE
    if (readRequests.length > 0 && readRounds < READ_ROUNDS) readRounds += 1
    pushFeedback(messages, calls, prose, feedback, boundedRead, readRequests)
  }
  return result
}
