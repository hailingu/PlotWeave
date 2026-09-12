/** #91：query 改写通道的解析与回退——改写失败不阻断回合。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { llmChat } from './chat'
import { parseRewrittenQuery, rewriteActionQuery, REWRITE_TIMEOUT_MS } from './queryRewrite'
import type { ProviderConfig } from '../../settings/types'

vi.mock('./chat', () => ({ llmChat: vi.fn() }))
const chat = vi.mocked(llmChat)
const provider: ProviderConfig = {
  id: 'p', label: '测试', baseUrl: 'https://example.test/v1', enabled: true, models: ['m'],
}

beforeEach(() => { chat.mockReset() })

describe('parseRewrittenQuery · 规范请求提取', () => {
  it.each([
    ['修改场04的对白', '修改场04的对白'],
    ['  "修改场04的对白" ', '修改场04的对白'],
    ['「修改场04的对白」', '修改场04的对白'],
    ['修改场04的对白。', '修改场04的对白'],
    ['增加一场对手戏', '增加一场对手戏'],
    // 目标文本含英文 None 不影响规范改写采信（PR #92 评审第四轮）
    ['修改对白：None of us knew', '修改对白：None of us knew'],
    ['NONE', null], ['none', null], ['无', null], ['', null], ['   ', null], [null, null],
    // PR #92 评审：整回复校验——NONE 标记夹带解释、解释性文字一律拒绝
    ['NONE（这不是修改请求）', null],
    ['这不是修改请求，应回复 NONE', null],
    ['好的，我会修改场04的对白', null],
  ])('%j → %j', (content, expected) => {
    expect(parseRewrittenQuery(content)).toBe(expected)
  })
})

describe('rewriteActionQuery · 改写调用与回退', () => {
  it('请求进入消息序列且不携带工具，改写结果原样返回', async () => {
    chat.mockResolvedValue({ role: 'assistant', content: '修改场04的对白' })
    expect(await rewriteActionQuery(provider, 'm', '扩写场04的对白')).toBe('修改场04的对白')
    expect(chat).toHaveBeenCalledTimes(1)
    expect(chat.mock.calls[0][2][chat.mock.calls[0][2].length - 1]?.content).toContain('扩写场04的对白')
    expect(chat.mock.calls[0][3]).toBeUndefined()
  })

  it('传输失败与空内容都回退为 null，不向回合抛出', async () => {
    chat.mockRejectedValueOnce(new Error('网络中断'))
    expect(await rewriteActionQuery(provider, 'm', '扩写场04的对白')).toBeNull()
    chat.mockResolvedValueOnce({ role: 'assistant', content: null })
    expect(await rewriteActionQuery(provider, 'm', '扩写场04的对白')).toBeNull()
  })

  it('改写超过独立短超时即回退，不长期阻塞主回合（PR #92 评审第四轮）', async () => {
    vi.useFakeTimers()
    try {
      chat.mockImplementation(() => new Promise(() => undefined)) // 供应商挂起
      const pending = rewriteActionQuery(provider, 'm', '扩写场04的对白')
      const settled = expect(pending).resolves.toBeNull()
      await vi.advanceTimersByTimeAsync(REWRITE_TIMEOUT_MS)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })
})
