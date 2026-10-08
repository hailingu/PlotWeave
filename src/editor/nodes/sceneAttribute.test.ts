import { describe, expect, it } from 'vitest'
import { sceneAttribute } from './sceneAttribute'

describe('场景属性的显示兼容（docs/ui-design.md §4.7）', () => {
  it.each([
    ['time', '🌙 夜', '夜', 'moon'],
    ['time', '☀️ 日', '日', 'sun'],
    ['time', '☀︎ 白天', '白天', 'sun'],
    ['time', '夜', '夜', 'moon'],
    ['time', '凌晨 03:00', '凌晨 03:00', 'clock'],
    ['weather', '🌧 雨', '雨', 'rain'],
    ['weather', '🌧️雨', '雨', 'rain'],
    ['weather', '❄︎ 雪', '雪', 'snow'],
    ['weather', '风', '风', 'wind'],
    ['weather', '☁️ 阴', '阴', 'cloud'],
    ['weather', '薄雾', '薄雾', 'cloud'],
    ['weather', '雨后 🌈', '雨后 🌈', 'cloud'],
    ['time', '✨ 梦境', '✨ 梦境', 'clock'],
    ['time', '🌙', '🌙', 'clock'],
  ] as const)('%s「%s」保留文字并选择单色符号', (kind, value, label, icon) => {
    expect(sceneAttribute(kind, value)).toEqual({ label, icon })
  })

  it.each(['', '  ', '\n'])('空值 %j 不制造标签', (value) => {
    expect(sceneAttribute('time', value)).toBeNull()
    expect(sceneAttribute('weather', value)).toBeNull()
  })
})
