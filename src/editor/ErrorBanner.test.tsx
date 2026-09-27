// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorBanner } from './ErrorBanner'

/**
 * 错误横幅消费点绑定（issue #362，承 #318）：横幅配色唯一出口是共用类
 * `.pw-error-banner`（配色经 CSS 侧 sheetTokens 配对/接线契约持有）。
 * 本断言钉住 TSX 消费点——渲染产物不得出现内联颜色（style 属性与
 * 颜色字面），把内联硬编码配色写回组件即失败。
 */
describe('ErrorBanner 消费点绑定（issue #362）', () => {
  afterEach(cleanup)

  it('role=alert + 共用类；渲染产物无内联样式与颜色字面', () => {
    const { container } = render(<ErrorBanner message="保存失败" />)
    const banner = screen.getByRole('alert')
    expect(banner.className).toBe('pw-error-banner')
    expect(banner.textContent).toBe('保存失败')
    const html = container.innerHTML
    expect(html, '不得出现内联 style 属性').not.toMatch(/\bstyle=/i)
    expect(html, '不得出现 hex 颜色字面').not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(html, '不得出现函数颜色字面').not.toMatch(
      /\b(?:rgb|rgba|hsl|hsla)\(/i,
    )
  })
})
