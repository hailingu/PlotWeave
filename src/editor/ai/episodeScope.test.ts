import { describe, expect, it } from 'vitest'
import { requestForEntry, validateEpisodeScope } from './episodeScope'
import { validateAiBatch } from './batchFold'
import { snap } from './testGraphs'

/** 同时覆盖新建载荷与既有节点补丁，形状校验由生产验证器提供。 */
function proposal() {
  return validateAiBatch(
    [
      {
        op: 'create_node',
        nodeType: 'beat',
        data: { name: '转折', episodeNo: 1 },
      },
      { op: 'update_node', nodeId: 'n1', patch: { episodeNo: 1 } },
    ],
    snap(),
  )
}

describe('本轮分集范围', () => {
  it.each([
    '根据剧情增加新的节拍',
    '增加未分集节拍',
    '新增节拍，不分集',
    '保持未分集，增加节拍',
    '给场景增加对白',
    '补充故事集合',
    '增加节拍，不要分集',
    '不要恢复第一集，增加节拍',
    '不用修改集归属，只增加节拍',
    '如何安排分集？',
    'Add beats without changing episodes',
    'How should I group episodes?',
    '',
  ])('拒绝超范围的创建和更新：%s', (request) => {
    expect(validateEpisodeScope(proposal(), request)).toMatchObject({
      ok: false,
      commands: [],
      issues: [{ index: 0 }, { index: 1 }],
    })
  })
  it.each([
    '创建第一集并安排节拍',
    '为现有节奏卡安排合适的分集',
    '把场景归入第 1 集',
    '把未分集场景归入第 1 集',
    '不要解释，为现有节拍分集',
    'Create episode 1 and add beats',
    'Set episodeNo to 1',
  ])('保留明确分集操作：%s', (request) => {
    const batch = proposal()
    expect(validateEpisodeScope(batch, request)).toBe(batch)
  })
  it('普通批次可保持未分集，模型文案中的第一集不构成授权', () => {
    const batch = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'beat',
          data: { name: '第一集', tone: '分集' },
        },
        { op: 'update_node', nodeId: 'n1', patch: { name: '第 1 集回忆' } },
      ],
      snap(),
    )
    expect(batch.ok).toBe(true)
    expect(validateEpisodeScope(batch, '根据剧情增加新的节拍')).toBe(batch)
  })
  it('不把缺失或形状校验失败的批次变成可执行', () => {
    expect(validateEpisodeScope(null, '创建第一集')).toBeNull()
    const invalid = validateAiBatch(
      [{ op: 'update_node', nodeId: 'n1', patch: { episodeNo: 0 } }],
      snap(),
    )
    expect(validateEpisodeScope(invalid, '创建第一集')).toBe(invalid)
  })
  it('卡片只认所属请求，忽略后续分集请求、助手和 note', () => {
    const thread = [
      { id: 1, kind: 'msg' as const, role: 'user' as const, text: '增加节拍' },
      { id: 2, kind: 'note' as const, text: '第一集' },
      {
        id: 3,
        kind: 'msg' as const,
        role: 'assistant' as const,
        text: '第一集',
      },
      {
        id: 4,
        kind: 'msg' as const,
        role: 'user' as const,
        text: '创建第一集',
      },
    ]
    expect(requestForEntry(thread, 2)).toBe('增加节拍')
    expect(requestForEntry(thread, 4)).toBe('创建第一集')
    expect(requestForEntry(thread, 0)).toBe('')
  })
})
