// @vitest-environment happy-dom
/** PR #85 总量回归：待执行卡占用历史容量，超额时保留最新提案；
 * 经真实落盘管线（persistedEntries 形态映射 + diskSessionOf 落盘边界
 * 容量，即 aiSessionStore 写入时的同一组合）、JSON 与加载归一化验证
 * 顺序、对账及输入不变。 */
import { afterEach, expect, it } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import {
  diskSessionOf,
  normalizeAiSession,
  persistedEntries,
  type AiSession,
  type ThreadEntry,
} from './session'
import { useAiSessionPersistence } from './useAiSessionPersistence'

afterEach(cleanup)

/** 生产管线的纯函数组合：面板全量形态 → 落盘边界容量。 */
const save = (thread: ThreadEntry[]): ThreadEntry[] =>
  diskSessionOf({ schemaVersion: 1, entries: persistedEntries(thread) }).entries

/** 生成带可恢复命令载荷的合法待执行卡，避免只验证空卡的条目数。 */
function proposal(id: number): ThreadEntry {
  return {
    id, kind: 'msg', role: 'assistant', text: `提案 ${id}`,
    card: {
      status: 'pending',
      v: {
        ok: true, hasDeletes: false, issues: [],
        items: [{ kind: 'create', key: `node-${id}`, label: '新场景', danger: false }],
        commands: [{ op: 'create_node', nodeType: 'scene', data: { name: `场景 ${id}` } }],
      },
    },
  }
}

/** 在提案后追加可区分的普通历史，验证剩余额度按时间线末尾补齐。 */
function notes(start: number, count = 200): ThreadEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: start + i, kind: 'note', text: `消息 ${start + i}`,
  }))
}

it('多张窗口外待执行卡占用 200 条总容量，并保留最新普通历史', () => {
  const thread = [proposal(1), proposal(2), ...notes(3)]
  const original = structuredClone(thread)
  const saved = save(thread)
  expect(saved).toHaveLength(200)
  expect(saved.slice(0, 3).map((entry) => entry.id)).toEqual([1, 2, 5])
  expect(saved[199].id).toBe(202)
  expect(saved.filter((entry) => entry.card)).toEqual([proposal(1), proposal(2)])
  expect(thread).toEqual(original)
})

it.each([
  { count: 199, first: 1, last: 399, proposals: 199, history: 1 },
  { count: 200, first: 1, last: 200, proposals: 200, history: 0 },
  { count: 201, first: 2, last: 201, proposals: 200, history: 0 },
])('$count 张待执行卡：容量不足先裁普通历史，再裁最旧提案', (testCase) => {
  const thread = [
    ...Array.from({ length: testCase.count }, (_, i) => proposal(i + 1)),
    ...notes(testCase.count + 1),
  ]
  const saved = save(thread)
  expect(saved).toHaveLength(200)
  expect(saved[0].id).toBe(testCase.first)
  expect(saved[199].id).toBe(testCase.last)
  expect(saved.filter((entry) => entry.card)).toHaveLength(testCase.proposals)
  expect(saved.filter((entry) => entry.kind === 'note')).toHaveLength(testCase.history)
  expect(thread).toHaveLength(testCase.count + 200)
})

it('较新待执行卡与较旧卡共享容量，输出按原顺序且不重复', () => {
  const saved = save([proposal(900), ...notes(1000), proposal(7)])
  expect(saved).toHaveLength(200)
  expect(saved.slice(0, 3).map((entry) => entry.id)).toEqual([900, 1002, 1003])
  expect(saved[199].id).toBe(7)
  expect(saved.filter((entry) => entry.card).map((entry) => entry.id)).toEqual([900, 7])
  expect(new Set(saved.map((entry) => entry.id)).size).toBe(200)
})

it.each(['dismissed', 'executed'] as const)('旧卡转为 %s 后释放优先容量', (status) => {
  const thread = [proposal(1), proposal(2), ...notes(3)]
  expect(save(thread)).toHaveLength(200)
  const changed = thread.map((entry) => entry.id === 1 && entry.card
    ? { ...entry, card: { ...entry.card, status } } : entry)
  const saved = save(changed)
  expect(saved).toHaveLength(200)
  expect(saved.slice(0, 3).map((entry) => entry.id)).toEqual([2, 4, 5])
  expect(saved[199].id).toBe(202)
  expect(saved.some((entry) => entry.id === 1)).toBe(false)
  expect(thread[0].card?.status).toBe('pending')
})

it('多张未确认执行卡先剔除回执再分配容量，重载保留命令与对账身份', () => {
  const thread: ThreadEntry[] = [proposal(1), proposal(2)].map((entry) => ({
    ...entry, card: {
      ...entry.card!, status: 'executed', uncommitted: true, aiRevisionAfter: entry.id + 7,
    },
  }))
  thread.push(...notes(3),
    { id: 203, kind: 'note', text: '执行回执一', cardReceiptFor: 1 },
    { id: 204, kind: 'note', text: '执行回执二', cardReceiptFor: 2 })
  const original = structuredClone(thread)
  const saved = save(thread)
  const restored = normalizeAiSession(JSON.parse(JSON.stringify({ schemaVersion: 1, entries: saved })))
  expect(restored.repaired).toBe(false)
  expect(restored.session.entries).toHaveLength(200)
  expect(restored.session.entries.slice(0, 3).map((entry) => entry.id)).toEqual([1, 2, 5])
  expect(restored.session.entries[0].card).toEqual({ ...proposal(1).card, aiRevisionAfter: 8 })
  expect(restored.session.entries[1].card).toEqual({ ...proposal(2).card, aiRevisionAfter: 9 })
  expect(restored.session.entries[199].id).toBe(202)
  expect(save(restored.session.entries)).toEqual(saved)
  expect(thread).toEqual(original)
})

it('校验拒绝卡不可执行：不占优先容量，按普通历史分配', () => {
  const rejected: ThreadEntry = {
    ...proposal(1),
    card: {
      ...proposal(1).card!,
      v: { ...proposal(1).card!.v, ok: false, issues: [{ index: 0, message: '未知字段' }] },
    },
  }
  const saved = save([rejected, ...notes(2)])
  expect(saved).toHaveLength(200)
  expect(saved.some((entry) => entry.card !== undefined)).toBe(false)
  expect(saved[0].id).toBe(2)
  expect(saved[199].id).toBe(201)
})

it('旧超额会话加载不写回，后续编辑保存并重载后总量收敛', async () => {
  const loaded = normalizeAiSession({
    schemaVersion: 1, entries: [proposal(1), proposal(2), ...notes(3)],
  }).session
  let disk: AiSession = structuredClone(loaded)
  // 模拟 aiSessionStore 落盘边界：对全量形态施加容量裁剪
  const writeToDisk = async (session: AiSession): Promise<void> => {
    disk = normalizeAiSession(JSON.parse(JSON.stringify(diskSessionOf(session)))).session
  }
  const { rerender } = renderHook(
    ({ entries }) => useAiSessionPersistence(entries, null, writeToDisk, undefined),
    { initialProps: { entries: loaded.entries } },
  )
  expect(disk.entries).toHaveLength(202)
  rerender({ entries: [...loaded.entries, ...notes(203, 1)] })
  await waitFor(() => { expect(disk.entries).toHaveLength(200) })
  expect(disk.entries.slice(0, 3).map((entry) => entry.id)).toEqual([1, 2, 6])
  expect(disk.entries[199].id).toBe(203)
  expect(loaded.entries).toHaveLength(202)
})
