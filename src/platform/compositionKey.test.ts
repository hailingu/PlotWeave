/**
 * 输入法组合键判定（issue #570）：应用层的 Enter/Escape 动作必须让位给
 * 输入法在途的组合——两种浏览器事件顺序都要识别：规范顺序下组合中的
 * keydown 带 isComposing === true；WebKit（Safari/WKWebView）确认或取消组合
 * 的 Enter/Esc 的 keydown 晚于 compositionend 到达，isComposing 已为 false，
 * 仅 keyCode === 229（"由输入法处理"）可辨识（WebKit bug 165004）。
 */
import { describe, expect, it } from 'vitest'
import { isCompositionKey } from './compositionKey'

describe('isCompositionKey（issue #570）', () => {
  it('规范顺序：组合中的 keydown（isComposing）属于输入法', () => {
    expect(isCompositionKey({ isComposing: true, keyCode: 229 })).toBe(true)
    expect(isCompositionKey({ isComposing: true, keyCode: 13 })).toBe(true)
  })

  it('WebKit 乱序：compositionend 之后的 keyCode 229 仍属于输入法', () => {
    expect(isCompositionKey({ isComposing: false, keyCode: 229 })).toBe(true)
  })

  it('真实按键：非组合且非 229 的 keydown 由应用处理', () => {
    expect(isCompositionKey({ isComposing: false, keyCode: 13 })).toBe(false)
    expect(isCompositionKey({ isComposing: false, keyCode: 27 })).toBe(false)
    expect(isCompositionKey({ isComposing: false, keyCode: 0 })).toBe(false)
  })
})
