/**
 * aiThreadModel 纯函数测试：请求消息序列组装的历史上界——
 * 持久化会话跨重启增长，无界历史会顶穿供应商上下文并使后续轮次
 * 持续失败，喂给模型的部分必须按条数与字符双界截断（完整线程仅
 * 用于界面展示）。
 */
import { describe, expect, it } from 'vitest'
import { buildMessages } from './aiThreadModel'
import type { ThreadEntry } from '../ai/session'

const msg = (id: number, role: 'user' | 'assistant', text: string): ThreadEntry => ({
  id,
  kind: 'msg',
  role,
  text,
})

/** 同一助手回复对应的待确认或历史执行卡，检查状态是否到达模型边界。 */
function batchEntry(status: 'pending' | 'executed' | 'dismissed'): ThreadEntry {
  return {
    ...msg(2, 'assistant', '给开场补充旁白。'),
    card: {
      status,
      v: {
        ok: true, hasDeletes: false, issues: [],
        commands: [{ op: 'update_node', nodeId: 'd1', patch: { nodeType: 'dialogue', patch: { lines: [] } } }],
        items: [{ kind: 'update', key: 'u0', label: '修改 对白·开场（lines）', danger: false }],
      },
    },
  }
}

describe('buildMessages 批次执行上下文（issue 73）', () => {
  it('同一回复的待确认与执行成功产生不同请求，成功记录绑定原消息', () => {
    const pending = buildMessages([batchEntry('pending')], '再丰富点', false)
    const executed = buildMessages([
      batchEntry('executed'),
      { id: 3, kind: 'note', text: '✓ 已执行 1 项改动。', cardReceiptFor: 2 },
    ], '再丰富点', false)
    expect(executed).not.toEqual(pending)
    // §12.2 模型上下文：每张卡的 JSON 状态记录附在所属消息尾部。
    expect(JSON.parse(historyOf(executed)[0].content.split('\n').slice(-1)[0])).toMatchObject({
      batchId: 2, status: 'executed', commandCount: 1, currentEffect: 'unknown',
    })
  })
})

const historyOf = (messages: ReturnType<typeof buildMessages>) =>
  messages.filter((m) => m.role !== 'system')

/** 读取 §12.2 附在消息尾部的应用 JSON 记录，断言供应商收到的状态语义。 */
function recordOf(entry: ThreadEntry): Record<string, unknown> {
  const history = historyOf(buildMessages([entry], '继续', false))
  const record = history[0].content.split('\n[应用批次记录]\n')[1]
  expect(record).toBeDefined()
  return JSON.parse(record) as Record<string, unknown>
}

describe('buildMessages 批次状态边界', () => {
  it.each(['pending', 'dismissed'] as const)('%s 卡不可被表述为执行成功', (status) => {
    expect(recordOf(batchEntry(status))).toMatchObject({ batchId: 2, status, commandCount: 1 })
  })

  it('校验失败保留诊断，不把已解析的命令子集视为待执行的合法整批', () => {
    const entry = batchEntry('pending')
    entry.card!.v.ok = false
    entry.card!.v.issues = [{ index: 0, message: '目标节点不存在' }]
    expect(recordOf(entry)).toMatchObject({ status: 'validation_failed', issues: ['目标节点不存在'] })
  })

  it('大批次只保留有限预览，完整命令与长台词不重复进入历史', () => {
    const entry = batchEntry('executed')
    entry.card!.v.commands = Array.from({ length: 100 }, () => ({
      op: 'create_node', nodeType: 'dialogue', data: { name: '新节点', lines: [
        { kind: 'action', text: '不应重复的台词正文'.repeat(10_000) },
      ] },
    }))
    entry.card!.v.items = Array.from({ length: 100 }, (_, i) => ({
      kind: 'create', key: `c${i}`, label: `新建${i}：${'长名称'.repeat(1000)}`, danger: false,
    }))
    const record = recordOf(entry)
    expect(record).toMatchObject({ commandCount: 100, omittedChanges: 94 })
    expect(record.changes).toHaveLength(6)
    expect(JSON.stringify(record)).not.toContain('不应重复的台词正文')
    expect(JSON.stringify(record).length).toBeLessThan(1500)
  })

  it('字符预算包含批次记录，条数裁剪不会留下旧批次的孤立回执', () => {
    const entry = batchEntry('executed')
    entry.text = 'a'.repeat(100)
    const history = historyOf(buildMessages([msg(1, 'user', 'x'.repeat(47_900)), entry], '继续', false))
    expect(history).toHaveLength(2)
    const thread = [entry, ...Array.from({ length: 40 }, (_, i) => msg(i + 3, 'user', `m${i}`)),
      { id: 44, kind: 'note' as const, text: '✓ 已执行 1 项改动。', cardReceiptFor: 2 }]
    expect(historyOf(buildMessages(thread, '继续', false)).every((m) => !m.content.includes('batchId'))).toBe(true)
  })
})

describe('buildMessages 批次归属与旧历史兼容', () => {
  it('交错追加的回执不覆盖另一个批次的状态，也不由旧文本推测执行结果', () => {
    const thread: ThreadEntry[] = [batchEntry('executed'),
      { ...batchEntry('pending'), id: 4, text: '另一个方案' },
      { id: 5, kind: 'note', text: '✓ 已执行 1 项改动。', cardReceiptFor: 2 },
      { id: 6, kind: 'note', text: '执行失败：旧版无关联的回执' }]
    const records = historyOf(buildMessages(thread, '继续', false)).slice(0, -1)
      .map((m) => JSON.parse(m.content.split('\n').slice(-1)[0]) as Record<string, unknown>)
    expect(records).toMatchObject([{ batchId: 2, status: 'executed' }, { batchId: 4, status: 'pending' }])
  })

  it('失败诊断有界，已执行和已忽略状态不携带过时的失败结论', () => {
    const entry = batchEntry('pending')
    entry.card!.executionError = '执行失败的长诊断'.repeat(1000)
    expect(recordOf(entry)).toMatchObject({ status: 'execution_failed' })
    expect(String(recordOf(entry).executionError).length).toBeLessThan(200)
    for (const status of ['executed', 'dismissed'] as const) {
      entry.card!.status = status
      expect(recordOf(entry)).toMatchObject({ status })
      expect(recordOf(entry)).not.toHaveProperty('executionError')
    }
  })
})

describe('buildMessages 历史上界', () => {
  it('条数超界时自旧侧截断，仅保留最新一段历史', () => {
    const thread = Array.from({ length: 50 }, (_, i) => msg(i + 1, i % 2 ? 'assistant' : 'user', `m${i}`))
    const history = historyOf(buildMessages(thread, '新问题', false))
    expect(history).toHaveLength(41) // 40 条历史 + 本轮输入
    expect(history[0].content).toBe('m10')
    expect(history[history.length - 1]).toEqual({ role: 'user', content: '新问题' })
  })

  it('字符总量超界时自旧侧截断；最新一条即使单独超界也保留', () => {
    const big = 'x'.repeat(30_000)
    const thread = [msg(1, 'user', big), msg(2, 'assistant', big), msg(3, 'user', big + big)]
    const history = historyOf(buildMessages(thread, '继续', false))
    expect(history.map((m) => m.content)).toEqual([big + big, '继续'])
  })

  it('回执与工具错误 note 条目不进入模型历史', () => {
    const thread: ThreadEntry[] = [
      msg(1, 'user', '你好'),
      { id: 2, kind: 'note', text: '✓ 已执行 1 项改动。' },
    ]
    const history = historyOf(buildMessages(thread, '继续', false))
    expect(history.some((m) => m.content.includes('已执行'))).toBe(false)
  })
})
