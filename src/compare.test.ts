import { describe, expect, it } from 'vitest'
import { compareCodeUnits } from './compare'

describe('compareCodeUnits（UTF-16 码元序，与 String.prototype 默认序一致）', () => {
  it('大写在小写之前（码元序，非 locale 序）', () => {
    expect(['b', 'A', 'a', 'B'].sort(compareCodeUnits)).toEqual(['A', 'B', 'a', 'b'])
  })

  it('代理对按首码元参与比较（区别于码点序）', () => {
    // 😀 = U+1F600（码元 D83D DE00）排在 U+E000（单码元）之前
    expect(['\uE000', '😀'].sort(compareCodeUnits)).toEqual(['😀', '\uE000'])
  })

  it('相等返回 0；比较结果与默认 sort() 完全一致（规范化签名依赖此稳定性）', () => {
    const sample = ['scene-9->beat-1', 'beat-2->scene-1', 'a', 'A', '', 'scene-9->beat-1']
    expect([...sample].sort(compareCodeUnits)).toEqual([...sample].sort())
    expect(compareCodeUnits('x', 'x')).toBe(0)
  })
})
