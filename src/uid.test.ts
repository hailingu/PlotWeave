import { describe, expect, it } from 'vitest'
import { uid } from './uid'

/** uid 的 v4 UUID 契约（RFC 4122 §4.4）：CSPRNG 随机性，
 * 防 SonarQube S2245 退回 Math.random 类弱伪随机。 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uid（本地标识符 = 前缀 + crypto.randomUUID）', () => {
  it('同一毫秒内高频生成不碰撞：5000 个 ID 全部唯一', () => {
    const ids = Array.from({ length: 5000 }, () => uid('scene'))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('保留可读前缀，尾部是合法 v4 UUID', () => {
    for (const prefix of ['scene', 'local-la']) {
      const id = uid(prefix)
      expect(id.startsWith(`${prefix}-`)).toBe(true)
      expect(id.slice(prefix.length + 1)).toMatch(UUID_V4)
    }
  })
})
