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

const historyOf = (messages: ReturnType<typeof buildMessages>) =>
  messages.filter((m) => m.role !== 'system')

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
