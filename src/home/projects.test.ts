import { describe, expect, it } from 'vitest'
import {
  createSampleProjects,
  filterProjects,
  formatRelativeTime,
  projectStatsLabel,
  type ProjectSummary,
} from './projects'

const p = (over: Partial<ProjectSummary>): ProjectSummary => ({
  id: 'x',
  name: '午夜出租车',
  sceneCount: 12,
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
})

describe('projectStatsLabel（海报底部统计）', () => {
  it('场景数 + 结局后缀的三种形态', () => {
    expect(projectStatsLabel(p({ sceneCount: 24, endingCount: 2 }))).toBe('24 场 · 双结局')
    expect(projectStatsLabel(p({ sceneCount: 24, endingCount: 3 }))).toBe('24 场 · 3 结局')
    expect(projectStatsLabel(p({ sceneCount: 24 }))).toBe('24 场')
    expect(projectStatsLabel(p({ sceneCount: 24, endingCount: 1 }))).toBe('24 场')
  })
})

describe('filterProjects（内存过滤）', () => {
  const projects = [
    p({ id: 'a', name: '午夜出租车' }),
    p({ id: 'b', name: '都市奇缘' }),
    p({ id: 'c', name: 'Midnight Cab' }),
  ]

  it('子串匹配、拉丁大小写不敏感；空白查询原样返回同一引用', () => {
    expect(filterProjects(projects, '午夜').map((x) => x.id)).toEqual(['a'])
    expect(filterProjects(projects, '奇缘').map((x) => x.id)).toEqual(['b'])
    expect(filterProjects(projects, 'midnight').map((x) => x.id)).toEqual(['c'])
    expect(filterProjects(projects, 'URBAN').map((x) => x.id)).toEqual([])
    expect(filterProjects(projects, '   ')).toBe(projects)
  })
})

describe('formatRelativeTime（注入时钟，边界档位）', () => {
  const now = new Date('2026-08-28T12:00:00Z')
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString()

  it('刚刚 / 分钟 / 小时 / 昨天 / 天 / 月日 各档', () => {
    expect(formatRelativeTime(iso(30_000), now)).toBe('刚刚')
    expect(formatRelativeTime(iso(5 * 60_000), now)).toBe('5 分钟前')
    expect(formatRelativeTime(iso(3 * 3_600_000), now)).toBe('3 小时前')
    expect(formatRelativeTime(iso(26 * 3_600_000), now)).toBe('昨天')
    expect(formatRelativeTime(iso(5 * 86_400_000), now)).toBe('5 天前')
    expect(formatRelativeTime(iso(40 * 86_400_000), now)).toMatch(/月 \d+ 日/)
  })

  it('未来时间与非法输入返回空串', () => {
    expect(formatRelativeTime(new Date(now.getTime() + 1000).toISOString(), now)).toBe('')
    expect(formatRelativeTime('not-a-date', now)).toBe('')
  })
})

describe('createSampleProjects（占位数据）', () => {
  it('两张卡片：带封面与不带；updatedAt 按注入时钟回推', () => {
    const now = new Date('2026-08-28T12:00:00Z')
    const list = createSampleProjects(now)
    expect(list.map((x) => x.id)).toEqual(['sample-du-shi-qi-yuan', 'sample-wu-ye-chu-zu-che'])
    expect(list[0].cover).toContain('linear-gradient')
    expect(list[1].cover).toBeUndefined()
    expect(list[0].updatedAt).toBe(new Date(now.getTime() - 2 * 3_600_000).toISOString())
  })
})
