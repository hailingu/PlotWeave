import { llmChat, type AssistantMessage, type ChatMessage } from './chat'
import type { AiCommand, BatchValidation } from './commands'
import { AI_TOOLS, toolCallsToCommands, type ReadRequest, type ToolCall } from './tools'
import type { ProviderConfig } from '../../settings/types'

/**
 * Agent 会话循环（数据模型 §12.2 朴素 tool-calling，issue 41 校验闭环）：
 * 读工具就地执行回喂后重问（≤ READ_ROUNDS 轮）；写命令交给调用方整批
 * 校验，未通过且未耗尽重试预算时把具体校验错误回喂模型（tool-calling
 * 通道按协议逐调用应答，```json 围栏通道以 user 消息回喂），产出共
 * ≤ WRITE_ATTEMPTS 次；通过、耗尽或纯讨论即终止。重试只发生在对话层，
 * 画布零副作用——批次仍须用户在预览卡确认后才执行。
 * 纯编排模块：不触碰 React 状态，llmChat 是唯一 I/O。
 */

/** 读工具就地回喂的最大轮数（§12.2 低轮次约束）。 */
const READ_ROUNDS = 3
/** 写批次的最多产出次数（首次 + 有限次纠错重试，issue 41）。 */
const WRITE_ATTEMPTS = 3

/** 会话循环的最终产出：最后一轮的文本、解析错误与整批校验结果。 */
export interface AgentLoopResult {
  /** 最后一轮助手文本（围栏批次可能仍在其中，展示侧负责剥除）。 */
  prose: string
  /** 工具参数解析失败清单（面向用户上屏的文案）。 */
  toolErrors: string[]
  /** 最后一轮写批次的校验结果；null = 纯讨论（无批次）。 */
  validation: BatchValidation | null
}

/** 双通道整批校验（由面板接线到 useAiBridge 的校验回调族）。 */
export interface BatchValidators {
  /** tool-calling 通道：命令数组校验；未接线视为不通过信息缺失（null）。 */
  commands?: (cmds: AiCommand[]) => BatchValidation | null
  /** 围栏通道：回复文本批次校验；无批次（纯讨论）返回 null。 */
  prose?: (text: string) => BatchValidation | null
}

export type ReadToolExecutor = (name: string, args: Record<string, unknown>) => string

/** 校验失败清单的人读文本（回喂与上屏共用同一编号口径）。 */
function issueListText(v: BatchValidation): string {
  return v.issues.map((i) => `第 ${i.index + 1} 条：${i.message}`).join('\n')
}

/** 校验失败的回喂消息（issue 41 纠错闭环）：tool-calling 通道按协议给
 * 每个调用应答（读工具就地执行、写调用收到校验错误），围栏通道以
 * assistant + user 对回喂并给出修正要求。 */
function pushValidationFeedback(
  messages: ChatMessage[],
  calls: ToolCall[],
  prose: string,
  v: BatchValidation,
  readTool: ReadToolExecutor,
  reads: ReadRequest[],
): void {
  const errorText = `你给出的改动批次未通过校验：\n${issueListText(v)}\n` +
    '请只使用各节点类型的合法字段（见字段表）重新输出完整批次；其余内容保持不变。'
  if (calls.length > 0) {
    messages.push({ role: 'assistant', content: prose, tool_calls: calls })
    const readById = new Map(reads.map((r) => [r.id, readTool(r.name, r.args)]))
    for (const c of calls) {
      messages.push({ role: 'tool', tool_call_id: c.id, content: readById.get(c.id) ?? errorText })
    }
    return
  }
  messages.push({ role: 'assistant', content: prose }, { role: 'user', content: errorText })
}

/** 朴素 tool-calling 循环：messages 原地追加，返回最后一轮结果。 */
export async function runAgentLoop(
  provider: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  readTool: ReadToolExecutor,
  validators: BatchValidators,
): Promise<AgentLoopResult> {
  let readRounds = 0
  let writeAttempts = 0
  let result: AgentLoopResult = { prose: '', toolErrors: [], validation: null }
  for (let round = 0; round < READ_ROUNDS + WRITE_ATTEMPTS; round++) {
    const reply: AssistantMessage = await llmChat(provider, model, messages, AI_TOOLS)
    const calls: ToolCall[] = reply.tool_calls ?? []
    const { commands, readRequests, errors } = toolCallsToCommands(calls)
    const prose = (reply.content ?? '').trim()
    const readsOnly = commands.length === 0 && errors.length === 0 && readRequests.length > 0
    if (readsOnly && readRounds < READ_ROUNDS) {
      readRounds += 1
      messages.push({ role: 'assistant', content: reply.content ?? '', tool_calls: calls })
      for (const r of readRequests) {
        messages.push({ role: 'tool', tool_call_id: r.id, content: readTool(r.name, r.args) })
      }
      continue
    }
    const validation = commands.length > 0
      ? (validators.commands?.(commands) ?? null)
      : (validators.prose?.(prose) ?? null)
    result = { prose, toolErrors: errors, validation }
    writeAttempts += 1
    if (validation !== null && !validation.ok && writeAttempts < WRITE_ATTEMPTS) {
      pushValidationFeedback(messages, calls, prose, validation, readTool, readRequests)
      continue
    }
    break
  }
  return result
}
