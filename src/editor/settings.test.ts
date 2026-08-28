import { describe, expect, it } from 'vitest'
import {
  createCharacter,
  createLocation,
  newEntityId,
  normalizeSettings,
  resolveCharacterAvatar,
  resolveCharacterName,
  resolveLocationName,
  type ProjectSettings,
} from './settings'

describe('实体创建', () => {
  it('id 带类型前缀；名字去空白', () => {
    const ch = createCharacter('  林晚 ')
    const loc = createLocation(' 天台 ')
    expect(ch.id.startsWith('ch-')).toBe(true)
    expect(loc.id.startsWith('loc-')).toBe(true)
    expect(ch.name).toBe('林晚')
    expect(loc.name).toBe('天台')
  })

  it('同一毫秒内连续创建的实体 id 不碰撞（防误引用/数据覆盖）', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newEntityId('ch')))
    expect(ids.size).toBe(50)
  })

  it('头像渐变按调色板轮转，第 7 个回到第 1 个', () => {
    const grads = Array.from({ length: 7 }, () => createCharacter('x').gradient)
    expect(grads[0]).not.toBe(grads[1])
    expect(grads[6]).toBe(grads[0])
  })
})

describe('引用解析（失效引用返回 null，由调用方按 §4.3 渲染）', () => {
  const settings: ProjectSettings = {
    characters: [
      { id: 'ch1', name: '林晚', gradient: 'g1' },
      { id: 'ch2', name: '  ', gradient: 'g2' },
    ],
    locations: [{ id: 'loc1', name: '天台' }],
  }

  it('角色：名字/头像（首字标签）', () => {
    expect(resolveCharacterName(settings, 'ch1')).toBe('林晚')
    expect(resolveCharacterName(settings, 'ghost')).toBeNull()
    expect(resolveCharacterAvatar(settings, 'ch1')).toEqual({ label: '林', gradient: 'g1' })
    expect(resolveCharacterAvatar(settings, 'ghost')).toBeNull()
  })

  it('空白名的头像标签兜底「？」', () => {
    expect(resolveCharacterAvatar(settings, 'ch2')?.label).toBe('?')
  })

  it('地点：名字与失效引用', () => {
    expect(resolveLocationName(settings, 'loc1')).toBe('天台')
    expect(resolveLocationName(settings, 'ghost')).toBeNull()
  })
})

describe('normalizeSettings（旧文件缺省合并）', () => {
  it('非对象/缺字段补空集；合法数组透传', () => {
    expect(normalizeSettings(null)).toEqual({ characters: [], locations: [] })
    expect(normalizeSettings('x')).toEqual({ characters: [], locations: [] })
    expect(normalizeSettings({ characters: [{ id: 'ch1', name: '林', gradient: 'g' }] })).toEqual({
      characters: [{ id: 'ch1', name: '林', gradient: 'g' }],
      locations: [],
    })
  })
})
