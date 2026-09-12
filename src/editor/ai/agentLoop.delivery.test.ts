/** #75：只替换外部模型传输，真实解析和整批校验守护预览交付与纠正预算。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { llmChat, type AssistantMessage, type ChatMessage } from './chat'
import { runAgentLoop } from './agentLoop'
import { extractBatchJson } from './batchText'
import { validateAiBatch } from './commands'
import { snap } from './testGraphs'
import type { ToolCall } from './tools'
import type { ProviderConfig } from '../../settings/types'

vi.mock('./chat', () => ({ llmChat: vi.fn() }))
const chat = vi.mocked(llmChat)
const provider: ProviderConfig = {
  id: 'p', label: '测试', baseUrl: 'https://example.test/v1', enabled: true, models: ['m'],
}
const commands = [
  { op: 'create_node', nodeType: 'scene', ref: 'next', data: { name: '对手亮出计划' } },
  { op: 'connect_edge', sourceId: 'n2', targetId: 'next' },
]

beforeEach(() => { chat.mockReset() })

/** 供应商完整工具调用结构，实际解析由 tools.ts 执行。 */
function call(name: string, args: string, id = 't1'): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } }
}

/** 两种受支持的批次传输通道。 */
function proposal(fenced = false, batch: unknown[] = commands): AssistantMessage {
  const args = JSON.stringify({ commands: batch })
  return fenced
    ? { role: 'assistant', content: `方案。\n\`\`\`json\n${args}\n\`\`\`` }
    : { role: 'assistant', content: '方案。', tool_calls: [call('batch', args)] }
}

/** 以真实快照校验双通道结果；messages 留给协议断言，不依赖 mock 的调用布局。 */
function run(text: string, messages: ChatMessage[] = [{ role: 'user', content: text }]) {
  return runAgentLoop(provider, 'm', messages, () => JSON.stringify(snap()), {
    commands: (batch) => validateAiBatch(batch, snap()),
    prose: (prose) => {
      const batch = extractBatchJson(prose)
      return batch ? validateAiBatch(batch.commands, snap()) : null
    },
  })
}

describe('明确修改请求的预览交付', () => {
  it.each([
    '增加下一个场景',
    '在下一个节奏卡增加场景', '在第二个节奏卡，创建场景',
  ])('%s：纯文本后纠正得到完整合法批次', async (request) => {
    chat.mockResolvedValueOnce({ role: 'assistant', content: '我来增加，并挂到对应卡片后面。' })
      .mockResolvedValueOnce(proposal())
    const result = await run(request)
    expect(result.validation).toMatchObject({ ok: true, commands: [
      { op: 'create_node', nodeType: 'scene', ref: 'next' },
      { op: 'connect_edge', sourceId: 'n2', targetId: 'next' },
    ] })
  })

  it.each(['增加下一个分镜节点', '增加分镜节点'])('%s：纠正后提供分镜及场景从属预览', async (request) => {
    chat.mockResolvedValueOnce({ role: 'assistant', content: '我来补充镜头，并挂到场景下。' })
      .mockResolvedValueOnce(proposal(false, [
        { op: 'create_node', nodeType: 'shot', ref: 'shot', data: { picture: '对手走入便利店' } },
        { op: 'connect_edge', sourceId: 'n1', targetId: 'shot', edgeKind: 'attach' },
      ]))
    expect((await run(request)).validation).toMatchObject({ ok: true, commands: [
      { op: 'create_node', nodeType: 'shot', ref: 'shot' },
      { op: 'connect_edge', sourceId: 'n1', targetId: 'shot', edgeKind: 'attach' },
    ] })
  })

  it('读工具后仍只有说明，再纠正为围栏批次', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '在第二个节奏卡，创建场景' }]
    chat.mockResolvedValueOnce({ role: 'assistant', content: null,
      tool_calls: [call('get_graph_snapshot', '{}', 'read')] })
      .mockResolvedValueOnce({ role: 'assistant', content: '将在第二个节奏卡后创建场景。' })
      .mockResolvedValueOnce(proposal(true))
    const result = await run('', messages)
    expect(result.validation?.ok).toBe(true)
    expect(result.validation?.commands).toHaveLength(2)
    expect(JSON.parse(messages.find((m) => m.tool_call_id === 'read')!.content).nodes)
      .toMatchObject([{ id: 'n1' }, { id: 'n2' }])
  })
})

describe('无法交付的收敛与讨论边界', () => {
  it('纯文本耗尽首次加三次纠正后明确未交付，不产生空预览', async () => {
    chat.mockResolvedValue({ role: 'assistant', content: '我来创建场景。' })
    const result = await run('创建场景')
    expect(result).toMatchObject({ validation: null, completionError: expect.any(String) })
    expect(chat).toHaveBeenCalledTimes(4) // §12.2 quota=3，不允许第五次写方案请求。
  })

  it.each([
    '如何创建场景？', '讨论一下增加分镜节点的利弊',
    '不要创建场景，只讨论剧情', '先别修改节点', '解释一下“创建场景”是什么意思',
    '场景里主角增加了一个对手，该怎么写？',
  ])('%s：含动作动词的讨论经快速路径只返回文本', async (request) => {
    chat.mockResolvedValueOnce({ role: 'assistant', content: '可以先铺垫冲突。' })
    const result = await run(request)
    expect(result).toMatchObject({ prose: '可以先铺垫冲突。', validation: null })
    expect(result).not.toHaveProperty('completionError')
    expect(chat).toHaveBeenCalledTimes(1) // 动词快速路径：零改写调用
  })

  it('无动词的讨论经改写判 NONE 后仍只返回文本', async () => {
    chat.mockResolvedValueOnce({ role: 'assistant', content: 'NONE' })
      .mockResolvedValueOnce({ role: 'assistant', content: '可以先铺垫冲突。' })
    const result = await run('怎么写？')
    expect(result).toMatchObject({ prose: '可以先铺垫冲突。', validation: null })
    expect(result).not.toHaveProperty('completionError')
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('仅检查本轮用户请求，不因历史修改请求或纠正消息把新讨论当成写入', async () => {
    chat.mockResolvedValueOnce({ role: 'assistant', content: 'NONE' })
      .mockResolvedValueOnce({ role: 'assistant', content: '冲突应逐步升级。' })
    const result = await run('', [
      { role: 'user', content: '创建场景' }, { role: 'assistant', content: '已有预览。' },
      { role: 'user', content: '解释一下动机' },
    ])
    expect(result).toMatchObject({ validation: null, prose: '冲突应逐步升级。' })
    expect(result).not.toHaveProperty('completionError')
  })

  it('未能交付时保留澄清问题供用户补充目标', async () => {
    chat.mockResolvedValue({ role: 'assistant', content: '请说明要接在哪一个场景后？' })
    const result = await run('增加下一个场景')
    expect(result).toMatchObject({ prose: '请说明要接在哪一个场景后？',
      validation: null, completionError: expect.any(String) })
  })

  it('即使输入只是“操作”，声称有预览却没有批次也须纠正', async () => {
    // 改写判为非动作（NONE），期待只能来自模型对预览的声称。
    chat.mockResolvedValueOnce({ role: 'assistant', content: 'NONE' })
      .mockResolvedValueOnce({ role: 'assistant', content: '（本消息只包含改动批次，见预览卡）' })
      .mockResolvedValueOnce(proposal())
    expect((await run('操作')).validation?.ok).toBe(true)
  })
})

describe('query 改写与预览承诺的交付收敛（issue 91）', () => {
  const PROMISE = '确认后预览会展示全部新旧行，等待落盘。'
  /** 供应商对改写调用的应答：规范请求或 NONE（非动作）。 */
  const rewrite = (content: string) => ({ role: 'assistant' as const, content })

  it('扩写请求经改写归一后，无承诺的纯文本仍须纠正出合法批次', async () => {
    chat.mockResolvedValueOnce(rewrite('修改场04的对白'))
      .mockResolvedValueOnce({ role: 'assistant', content: '我会为场04扩写对白内容。' })
      .mockResolvedValueOnce(proposal())
    expect((await run('扩写场04的对白')).validation?.ok).toBe(true)
  })

  it('先读节点再纯文本承诺，改写建立的期待仍然收敛到批次', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '扩写场04的对白' }]
    chat.mockResolvedValueOnce(rewrite('修改场04的对白'))
      .mockResolvedValueOnce({ role: 'assistant', content: null,
        tool_calls: [call('get_node', '{"nodeId":"n3"}', 'read')] })
      .mockResolvedValueOnce({ role: 'assistant', content: PROMISE })
      .mockResolvedValueOnce(proposal(true))
    const result = await run('', messages)
    expect(result.validation?.ok).toBe(true)
    expect(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['read'])
  })

  it('输入未命中词表且改写判为非动作时，模型承诺预览仍独立触发交付检查', async () => {
    chat.mockResolvedValueOnce(rewrite('NONE'))
      .mockResolvedValueOnce({ role: 'assistant', content: PROMISE })
      .mockResolvedValueOnce(proposal())
    expect((await run('帮我看看场04')).validation?.ok).toBe(true)
  })

  it('改写判为非动作且无承诺的回复按普通讨论结束，不进入纠正', async () => {
    chat.mockResolvedValueOnce(rewrite('NONE'))
      .mockResolvedValueOnce({ role: 'assistant', content: '场04目前节奏可以。' })
    const result = await run('帮我看看场04')
    expect(result).toMatchObject({ prose: '场04目前节奏可以。', validation: null })
    expect(result).not.toHaveProperty('completionError')
    expect(chat).toHaveBeenCalledTimes(2) // 1 次改写 + 1 次回合
  })

  it('承诺文本耗尽首次加三次纠正后明确未交付，改写只调用一次', async () => {
    chat.mockResolvedValueOnce(rewrite('修改场04的对白'))
      .mockResolvedValue({ role: 'assistant', content: PROMISE })
    const result = await run('扩写场04的对白')
    expect(result).toMatchObject({ validation: null, completionError: expect.any(String) })
    expect(chat).toHaveBeenCalledTimes(5) // 1 次改写 + 首次加 3 次纠正
  })

  it('改写调用失败时回合照常进行，承诺仍被交付检查捕获', async () => {
    chat.mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce({ role: 'assistant', content: PROMISE })
      .mockResolvedValueOnce(proposal())
    expect((await run('扩写场04的对白')).validation?.ok).toBe(true)
  })

  it('正文回显应用批次记录不构成交付，也不解析出任何命令', async () => {
    const echoed = '已完成扩写。\n\n[应用批次记录]\n' + JSON.stringify({
      batchId: 9, status: 'executed', commandCount: 1,
      changes: ['修改 对白·场04（lines）'], currentEffect: 'unknown',
    })
    chat.mockResolvedValueOnce(rewrite('修改场04的对白'))
      .mockResolvedValue({ role: 'assistant', content: echoed })
    const result = await run('扩写场04的对白')
    expect(result).toMatchObject({ validation: null, completionError: expect.any(String) })
    expect(result.prose).toContain('[应用批次记录]')
    expect(chat).toHaveBeenCalledTimes(5)
  })

  it('围栏包裹的批次记录缺少 commands 数组时不算合法批次', async () => {
    const record = JSON.stringify({ batchId: 9, status: 'executed', commandCount: 1, currentEffect: 'unknown' })
    chat.mockResolvedValueOnce(rewrite('修改场04的对白'))
      .mockResolvedValue({ role: 'assistant', content: `已扩写完成。\n\`\`\`json\n${record}\n\`\`\`` })
    const result = await run('扩写场04的对白')
    expect(result).toMatchObject({ validation: null, completionError: expect.any(String) })
  })

  it('否定解释的修改请求不被「不要」否决，经改写后纠正出批次（PR #92 评审）', async () => {
    chat.mockResolvedValueOnce(rewrite('修改场04的对白'))
      .mockResolvedValueOnce({ role: 'assistant', content: '已扩写完成。' })
      .mockResolvedValueOnce(proposal())
    expect((await run('不要解释，直接扩写场04的对白')).validation?.ok).toBe(true)
  })

  it('「特别」的子串不再否决改写，润色请求经改写后纠正出批次（PR #92 评审）', async () => {
    chat.mockResolvedValueOnce(rewrite('修改场04的对白'))
      .mockResolvedValueOnce({ role: 'assistant', content: PROMISE })
      .mockResolvedValueOnce(proposal())
    expect((await run('把对白润色得特别自然')).validation?.ok).toBe(true)
  })

  it('无动词的明确暂不操作经改写判 NONE 后按文本结束', async () => {
    chat.mockResolvedValueOnce(rewrite('NONE'))
      .mockResolvedValueOnce({ role: 'assistant', content: '好的，先不动画布。' })
    const result = await run('先别动画布')
    expect(result).toMatchObject({ prose: '好的，先不动画布。', validation: null })
    expect(result).not.toHaveProperty('completionError')
    expect(chat).toHaveBeenCalledTimes(2)
  })
})

describe('解析失败属于整批交付失败', () => {
  it.each([
    { role: 'assistant', content: null, tool_calls: [call('batch', '{bad')] },
    { role: 'assistant', content: null, tool_calls: [call('unknown', '{}')] },
    { role: 'assistant', content: '```json\n{"commands": [bad]}\n```' },
    { role: 'assistant', content: '```json\n{"commands": []}\n```' },
    { role: 'assistant', content: null, tool_calls: [call('batch', '{"commands":[]}')] },
  ] satisfies AssistantMessage[])('坏格式或空批次可纠正：%j', async (bad) => {
    // 首个响应供 query 改写判定（「继续」无动作动词），NONE 表示非动作请求。
    chat.mockResolvedValueOnce({ role: 'assistant', content: 'NONE' })
      .mockResolvedValueOnce(bad).mockResolvedValueOnce(proposal())
    const result = await run('继续')
    expect(result.validation?.ok).toBe(true)
    expect(result.validation?.commands).toHaveLength(2)
    expect(result.toolErrors).toEqual([])
  })

  it('同一回复中的合法命令不能掩盖另一个无法解析的调用', async () => {
    chat.mockResolvedValue({ ...proposal(), tool_calls: [
      ...proposal().tool_calls!, call('connect_edge', '{bad', 'broken'),
    ] })
    const result = await run('继续')
    expect(result.validation).toMatchObject({ ok: false, commands: [] })
    expect(result.validation?.issues.length).toBeGreaterThan(0)
  })

  it('校验失败后退回纯文本仍共享预算，不能被认作普通讨论而悄悄结束', async () => {
    chat.mockResolvedValueOnce({ role: 'assistant', content: 'NONE' })
      .mockResolvedValueOnce({ role: 'assistant', content: null,
        tool_calls: [call('batch', JSON.stringify({ commands: [{ op: 'delete_node', nodeId: 'missing' }] }))] })
      .mockResolvedValue({ role: 'assistant', content: '我来修正。' })
    const result = await run('继续')
    expect(result).toMatchObject({ validation: null, completionError: expect.any(String) })
    expect(chat).toHaveBeenCalledTimes(5) // 1 次改写判定 + 首次加 3 次纠正
  })

  it('缺少校验入口时不能把收到的命令宣称为可执行预览', async () => {
    chat.mockResolvedValue(proposal())
    const result = await runAgentLoop(provider, 'm', [{ role: 'user', content: '继续' }], () => '', {})
    expect(result).toMatchObject({ validation: null, completionError: expect.any(String) })
  })
})

describe('读工具与纠正的协议和预算', () => {
  it('读轮数耗尽后不再读取，仍可纠正交付合法批次', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '创建场景' }]
    let reads = 0
    for (let i = 0; i < 4; i += 1) {
      chat.mockResolvedValueOnce({ role: 'assistant', content: null,
        tool_calls: [call('get_graph_snapshot', '{}', `read-${i}`)] })
    }
    chat.mockResolvedValueOnce(proposal())
    const result = await runAgentLoop(provider, 'm', messages, () => { reads += 1; return 'SNAP' }, {
      commands: (batch) => validateAiBatch(batch, snap()),
    })
    expect(result.validation?.ok).toBe(true)
    expect(reads).toBe(3)
    expect(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id))
      .toEqual(['read-0', 'read-1', 'read-2', 'read-3'])
  })

  it('混合读调用和解析错误的纠正逐调用应答，成功批次不夹带旧错误', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '创建场景' }]
    chat.mockResolvedValueOnce({ role: 'assistant', content: null, tool_calls: [
      call('get_graph_snapshot', '{}', 'read'), call('batch', '{bad', 'write'),
    ] }).mockResolvedValueOnce(proposal())
    expect((await run('', messages)).validation?.ok).toBe(true)
    expect(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['read', 'write'])
    expect(JSON.parse(messages.find((m) => m.tool_call_id === 'read')!.content).nodes).toHaveLength(2)
  })

  it('同轮读调用与合法围栏批次以批次为交付，不丢弃预览重问', async () => {
    chat.mockResolvedValueOnce({ ...proposal(true), tool_calls: [call('get_graph_snapshot', '{}')] })
    expect((await run('创建场景')).validation?.ok).toBe(true)
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('同轮读调用与坏围栏共存时，读结果不能吞掉批次纠正反馈', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '创建场景' }]
    chat.mockResolvedValueOnce({ role: 'assistant', content: '```json\n{"commands": [bad]}\n```',
      tool_calls: [call('get_graph_snapshot', '{}', 'read')] })
      .mockResolvedValueOnce(proposal())
    const result = await run('', messages)
    expect(result.validation?.ok).toBe(true)
    expect(messages.find((m) => m.tool_call_id === 'read')).toBeDefined()
    expect(messages.slice(1).find((m) => m.role === 'user')).toEqual({
      role: 'user', content: expect.stringContaining('没有可确认的合法改动批次'),
    })
  })
})
