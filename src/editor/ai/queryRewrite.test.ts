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

/** 协议 JSON：要求修改并给出规范请求。 */
const ok = (query: string) => JSON.stringify({ action: true, query })

describe('parseRewrittenQuery · 协议 JSON 解析与整回复校验', () => {
  it.each([
    [ok('修改场04的对白'), '修改场04的对白'],
    [`  ${ok('修改场04的对白')}  `, '修改场04的对白'],
    [ok('增加一场对手戏'), '增加一场对手戏'],
    // 目标文本含英文 None 不影响规范改写采信（PR #92 评审第四轮）
    [ok('修改对白：None of us knew'), '修改对白：None of us knew'],
    ['```json\n' + ok('修改场04的对白') + '\n```', '修改场04的对白'],
    ['{"action":false}', null],
    ['NONE', null], ['none', null], ['无', null], ['', null], [null, null],
    // 分类标记与解释文字的混合回复、非 JSON 文本一律拒绝（PR #92 评审）
    ['NONE（这不是修改请求）', null],
    ['这不是修改请求，应回复 NONE', null],
    ['好的，我会修改场04的对白', null],
    ['修改场04的对白', null],
    ['{"action":true}', null],
    ['{"action":true,"query":"我觉得挺好的"}', null],
    ['{bad', null],
  ])('%j → %j', (content, expected) => {
    expect(parseRewrittenQuery(content)).toBe(expected)
  })
})

describe('rewriteActionQuery · 改写调用与回退', () => {
  it('请求进入消息序列且不携带工具，改写结果原样返回', async () => {
    chat.mockResolvedValue({ role: 'assistant', content: ok('修改场04的对白') })
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
