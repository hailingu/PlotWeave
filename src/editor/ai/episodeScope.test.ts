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

/** 内容定位、否定和引用不能授予额外集号；数据表不占据测试闭包。 */
const preservedRequests = [
  '根据剧情增加新的节拍',
  '不修改现有集号，只增加节拍',
  '集号不修改，新增节拍',
  '不需要分集，只补充对白',
  '沿用当前集号新增节拍',
  '保留现有分集，增加节拍',
  '现有集号不变，增加节拍',
  '根据第一集的剧情增加节拍',
  '修改第一集对白的标题为开场',
  '修改第1集中的对白文案',
  '修改标题并修改第一集对白文案',
  '修改第 1 集 对白标题',
  '更改第一集的场景名称',
  '调整第1集内的节拍内容',
  '设置第1集对白的标题为第二集',
  '设定第1集对白标题为开场',
  '修改第一集和第二集的对白标题',
  '更改第1集、第2集对白文案',
  '调整第1集以及第2集中的场景名称',
  '修改第一集和主角对白的标题',
  '修改第一集和参考第二集的对白标题',
  '新增节拍参考第一集',
  '增加节拍参考第一集',
  '添加对白参考第 2 集',
  '不新增第 2 集，只增加节拍',
  '不增加第 2 集，只增加节拍',
  '不添加第 2 集，只增加节拍',
  '保留现有分集，不新增第 2 集',
  '不新增两集，只增加节拍',
  'Add a beat based on episode 2',
  'Do not add episode 2; add a beat',
  'Keep existing episodes and add beats',
  '为现有节拍解释分集，增加节拍',
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
]

/** 明确的分集、归入和创建仍需保留合法范围。 */
const assignedRequests = [
  '创建第一集并安排节拍',
  '创建全新的第1集和第2集',
  '修改标题并把场景归入第1集以便整理',
  '修改对白并创建全新的第1集和第2集',
  '为节拍安排第1集和第2集',
  '新增第 2 集并添加节拍',
  '请新增第 2 集',
  '增加第 2 集',
  '添加第 2 集并创建节拍',
  '请帮我新增第 2 集',
  '新增 2 集并添加节拍',
  '增加两集',
  '新增第 9007199254740991 集',
  'Add episode 2 and create a beat',
  '为现有节奏卡安排合适的分集',
  '把场景归入第 1 集',
  '把未分集场景归入第 1 集',
  '在第 1 集新增节拍',
  '为第 2 集增加场景',
  '剧情不错，在第 1 集新增节拍',
  '给不错的节拍安排分集',
  '为现有节拍安排分集，不修改剧情',
  '不要解释，为现有节拍分集',
  'Create episode 1 and add beats',
  'Set episodeNo to 1',
  '修改第1集对白的集号为 2',
  '将对白改为第 2 集',
  '请在第1集新增对白',
  '新增第1集对白',
  '创建第一集的对白',
  '新增第1集和第2集',
  '创建第一集、第二集并安排节拍',
  '增加第1集以及第2集',
  '添加第1集与第2集及第3集',
  '新建第1集和第2集',
  '建立第一集、第二集',
  '新增第一集和新增第二集',
]

describe('本轮分集范围', () => {
  it.each(preservedRequests)('拒绝超范围的创建和更新：%s', (request) => {
    expect(validateEpisodeScope(proposal(), request)).toMatchObject({
      ok: false,
      commands: [],
      issues: [{ index: 0 }, { index: 1 }],
    })
  })
  it.each(assignedRequests)('保留明确分集操作：%s', (request) => {
    const batch = proposal()
    expect(validateEpisodeScope(batch, request)).toBe(batch)
    expect(validateEpisodeScope(batch, request, 'allow')).toBe(batch)
  })
})

describe('批次与原请求约束', () => {
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

  it.each([
    '不修改现有集号，只增加节拍',
    '保留现有分集，增加节拍',
    '修改第一集对白的标题为开场',
    '修改第1集中的对白文案',
    '修改第一集和第二集的对白标题',
    '更改第1集、第2集对白文案',
  ])('可见原始请求的保留要求优先于旧卡范围：%s', (request) => {
    expect(validateEpisodeScope(proposal(), request, 'allow')?.ok).toBe(false)
  })
  it('不把缺失或形状校验失败的批次变成可执行', () => {
    expect(validateEpisodeScope(null, '创建第一集')).toBeNull()
    const invalid = validateAiBatch(
      [{ op: 'update_node', nodeId: 'n1', patch: { episodeNo: 0 } }],
      snap(),
    )
    expect(validateEpisodeScope(invalid, '创建第一集')).toBe(invalid)
  })

  it('缺失原请求时可用保存范围，有原请求时范围不能放宽其限制', () => {
    const batch = proposal()
    expect(validateEpisodeScope(batch, '', 'allow')).toBe(batch)
    expect(
      validateEpisodeScope(batch, '根据剧情增加新的节拍', 'allow')?.ok,
    ).toBe(false)
    expect(validateEpisodeScope(batch, '创建第一集', 'preserve')?.ok).toBe(
      false,
    )
  })
})

describe('历史卡请求定位', () => {
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
