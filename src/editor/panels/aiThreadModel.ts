import { runAgentLoop, type ReadToolExecutor } from '../ai/agentLoop'
import { type ChatMessage } from '../ai/chat'
import { type BatchValidation } from '../ai/commands'
import { entityFieldTableText } from '../ai/entityFields'
import { nodeFieldTableText } from '../ai/nodeFields'
import type { ProviderConfig } from '../../settings/types'
import type { ThreadEntry } from '../ai/session'

export type { ThreadEntry } from '../ai/session'

/**
 * ✦AI 会话的模型域（RightPanel.tsx 拆分，issue #39）：系统提示、请求
 * 消息序列组装、单轮模型回合与会话条目（含改动预览卡状态）的派生。
 * 不触碰 React 状态；会话容器在 AiThread.tsx，预览卡在 PreviewCard.tsx。
 */

/** 会话条目：对话消息（助手消息可携带改动预览卡状态）或系统回执。
 * id 为面板内自增序号——条目只追加不删除，作稳定渲染 key（S6479）。 */
/** 助手人格与命令协议说明（§6/数据模型 §12.2）。节点字段表由
 * nodeFields.ts 生成（issue 41）、实体字段表由 entityFields.ts 生成
 * （issue 44）：提示词、工具描述与校验白名单同源，模型不再因协议缺失
 * 自造字段。 */
export const SYSTEM_PROMPT =
  '你是短剧创作助手，帮助编剧讨论剧情结构、人物动机与台词。\n' +
  '需要改动画布或设定集时，只产出命令：执行前界面会向用户展示改动预览并等待确认，' +
  '所以你不要声称已经完成修改。优先调用工具（推荐把一次改动的全部命令放进' +
  '一个 batch）；服务不支持工具时退回 ```json 围栏批次（格式 {"commands":[…]}）。\n' +
  '需要画布或设定集信息时先调用读工具 get_graph_snapshot / get_node / ' +
  'get_settings_snapshot。\n' +
  '各节点类型 data/patch 的合法字段（表外字段会被整批拒绝）：\n' +
  `${nodeFieldTableText()}\n` +
  '设定实体 fields 的合法字段（表外字段会被整批拒绝）：\n' +
  `${entityFieldTableText()}\n` +
  '命令要点：create_node 的 data 只写要定制的字段，ref 供本批后续命令引用' +
  '新节点；update_node_spec 的 patch 只写要改的字段；connect_edge 缺省为剧情流，' +
  'branch 需 optionIndex（0 基），attach 仅 场景→分镜卡；episodeNo 仅' +
  'scene/beat/dialogue/branch 可写（分镜随宿主场景）。\n' +
  '设定实体（issue 44）：upsert_character / upsert_location 新建或修改角色、' +
  '地点——新建不带 entityId（fields.name 必填，可带 ref）；修改必须带 entityId ' +
  '（设定集快照里的精确 id，同名实体也不要按名字猜 id），fields 只写要改的字段，' +
  '未提及字段保持不变；不支持删除或合并实体。同批可先 upsert 实体再绑定：' +
  'scene.characterIds / scene.locationId / lines[].speaker 可填实体 id 或本批 ref。\n' +
  '长篇设定文档（人物小传、世界观、术语表）与道具暂不支持 AI 写入：' +
  '可给出文本草稿由用户手动录入，不要创建分镜卡或场景卡冒充设定档案，' +
  '也不要声称已写入设定集。\n' +
  '画布快照的「剧情流顺序」即大纲投影：重排剧情 = 同一批次内先 disconnect 旧边' +
  '再 connect 新边；设定集段落给出角色/地点实体 id，写 characterIds/locationId 时引用它们。\n' +
  '规则：只使用快照里出现过的 id（新节点/新实体用 ref）；连线不得自环或成环；' +
  '每条命令可用 reason 说明理由。批次被校验拒绝时，按回喂的错误清单修正后' +
  '重新输出完整批次。'

/** 喂给模型的历史上界：条数与字符双界。持久化会话跨重启增长，无界
 * 历史会顶穿供应商上下文上限并使后续轮次持续失败；完整线程仅用于
 * 界面展示，此处只截取喂给模型的子集。 */
const HISTORY_MAX_MESSAGES = 40
const HISTORY_MAX_CHARS = 48_000

/** 自新向旧保留会话消息，条数与累计字符双界截断；最新一条即使单独
 * 超界也保留（保证模型至少看得到上一轮语境，本轮输入另计）。 */
function boundedHistory(thread: ThreadEntry[]): ThreadEntry[] {
  const msgs = thread.filter((e) => e.kind === 'msg')
  const kept: ThreadEntry[] = []
  let chars = 0
  for (let i = msgs.length - 1; i >= 0 && kept.length < HISTORY_MAX_MESSAGES; i -= 1) {
    chars += msgs[i].text.length
    if (chars > HISTORY_MAX_CHARS && kept.length > 0) break
    kept.unshift(msgs[i])
  }
  return kept
}

/** 组装本次请求的消息序列：系统提示 + 画布快照（可选）+ 会话历史
 * （双界截断，见 boundedHistory）+ 新输入。历史里的批次文本不再重复
 * 喂回（已渲染为预览卡，防止上下文膨胀）。 */
export function buildMessages(
  thread: ThreadEntry[],
  text: string,
  knowsCanvas: boolean,
  canvasDigest?: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(knowsCanvas && canvasDigest
      ? [{ role: 'system' as const, content: `当前画布快照：\n${canvasDigest}` }]
      : []),
  ]
  for (const e of boundedHistory(thread)) {
    if (e.kind === 'msg') messages.push({ role: e.role ?? 'assistant', content: e.text })
  }
  messages.push({ role: 'user', content: text })
  return messages
}

/** 助手回复 → 会话追加条目（runModelTurn 拆出）：工具错误回执 + 助手
 * 消息（可附预览卡）。批次存在时剥掉 ```json 围栏文本避免重复展示。 */
function assistantEntries(
  result: { prose: string; toolErrors: string[]; validation: BatchValidation | null },
  nextId: () => number,
): ThreadEntry[] {
  const { prose, toolErrors, validation } = result
  let displayText = validation ? prose.replace(/```json[\s\S]*?```/gi, '').trim() : prose
  if (!displayText && !validation) displayText = '（模型未返回内容）'
  return [
    ...(toolErrors.length > 0
      ? [{ id: nextId(), kind: 'note' as const, text: `⚠ ${toolErrors.join('；')}` }]
      : []),
    {
      id: nextId(),
      kind: 'msg',
      role: 'assistant',
      text: displayText || (validation ? '（本次回复只有改动批次，见下方预览卡）' : ''),
      ...(validation ? { card: { v: validation, status: 'pending' as const } } : {}),
    },
  ]
}

/** 单轮模型回合（send 拆出，issue 39）：跑 Agent 循环并把最终产出
 * 转为待追加的会话条目；网络/服务异常原样抛出，由调用方呈上屏错误。 */
export async function runModelTurn(
  provider: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  readTool: ReadToolExecutor,
  validators: Parameters<typeof runAgentLoop>[4],
  nextId: () => number,
): Promise<ThreadEntry[]> {
  const result = await runAgentLoop(provider, model, messages, readTool, validators)
  return assistantEntries(result, nextId)
}

/** 读工具就地执行（send 拆出）：快照来自常驻快照 prop，节点详情按 id 现查，
 * 设定集清单（issue 44）来自常驻读取器。 */
export function readToolOf(
  canvasDigest: string | undefined,
  onReadNode: ((nodeId: string) => string | null) | undefined,
  onReadSettings?: () => string,
): ReadToolExecutor {
  return (name, args) => {
    if (name === 'get_graph_snapshot') return canvasDigest ?? '（画布为空）'
    if (name === 'get_node') {
      const id = typeof args.nodeId === 'string' ? args.nodeId : ''
      return onReadNode?.(id) ?? `node not found: ${id}`
    }
    if (name === 'get_settings_snapshot') {
      return onReadSettings?.() ?? '{"characters":[],"locations":[]}'
    }
    return `unknown read tool: ${name}`
  }
}

/** 预览卡执行回执条目（executeCard 拆出）：失败 → 错误回执（批次未动，
 * 保持 pending）；成功 → 已执行回执。回执随会话持久化，不携带 ⌘Z
 * 撤销宣称——撤销栈不跨会话存活，该提示只在当前会话的卡片上呈现。 */
export function cardResultEntry(
  err: string | null,
  count: number,
  nextId: () => number,
): ThreadEntry {
  return err
    ? { id: nextId(), kind: 'note', text: `执行失败：${err}` }
    : { id: nextId(), kind: 'note', text: `✓ 已执行 ${count} 项改动。` }
}
