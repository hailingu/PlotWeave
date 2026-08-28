import { describe, expect, it } from 'vitest'
import { applyEpisodeTitle } from './episodeTitle'

describe('applyEpisodeTitle（§3.5 集标题映射的单一更新语义）', () => {
  it('非空标题写入对应集号；首尾空白被去除', () => {
    expect(applyEpisodeTitle({}, 1, '夜戏')).toEqual({ 1: '夜戏' })
    expect(applyEpisodeTitle({ 1: '旧' }, 2, '  第二集 ')).toEqual({ 1: '旧', 2: '第二集' })
  })

  it('非空标题覆盖同集旧标题', () => {
    expect(applyEpisodeTitle({ 3: '旧名' }, 3, '新名')).toEqual({ 3: '新名' })
  })

  it('标题清空（含纯空白）= 移除该集命名，而不是残留空字符串键', () => {
    expect(applyEpisodeTitle({ 1: '夜戏', 2: '日戏' }, 1, '')).toEqual({ 2: '日戏' })
    expect(applyEpisodeTitle({ 1: '夜戏' }, 1, '   ')).toEqual({})
  })

  it('对不存在的集清空 = 原映射原样返回，不产生幽灵键', () => {
    const titles = { 2: '日戏' }
    expect(applyEpisodeTitle(titles, 9, '')).toBe(titles)
  })
})
