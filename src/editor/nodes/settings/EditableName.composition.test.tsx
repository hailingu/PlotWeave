// @vitest-environment happy-dom
/**
 * 内联改名的输入法组合安全（issue #570）：组合在途的 Enter 不提交、Esc 不
 * 退出编辑；真实按键保持既有语义。两种浏览器事件顺序都必须归输入法：
 * 规范顺序的 keydown 带 isComposing；WebKit（Safari/WKWebView）确认/取消
 * 组合的 keydown 晚于 compositionend 到达，isComposing 已为 false、仅
 * keyCode 229 可辨识（WebKit bug 165004）。
 *
 * | 前置/状态 | 动作与事件顺序 | 可观察结果 | 不变量 / 责任方 | 验证 |
 * | --- | --- | --- | --- | --- |
 * | 编辑态，组合在途 | keydown Enter（isComposing） | 仍在编辑，不提交 | 组合在途的 Enter 归输入法 / EditableName | 本文件 |
 * | 编辑态，compositionend 已发 | keydown Enter（keyCode 229，isComposing=false） | 仍在编辑，不提交，上屏文本保留 | WebKit 乱序的确认键归输入法 / EditableName | 本文件 + 原生真实 WebKit |
 * | 编辑态，组合在途 | keydown Escape（isComposing 或 keyCode 229） | 仍在编辑，草稿保留 | 组合中的 Esc 只取消合成 / EditableName | 本文件 |
 * | 编辑态，非组合 | keydown Enter（keyCode 13）/ Escape（keyCode 27） | 提交一次 / 放弃并退出 | 守卫不收窄既有语义 / EditableName | 本文件 |
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EditableName } from './EditableName'

afterEach(cleanup)

/** 双击进入编辑并返回已聚焦的输入框（autoFocus 由 React 在挂载时触发）。 */
function openEditor() {
  const onChange = vi.fn()
  render(
    <EditableName value="场景一" onChange={onChange} ariaLabel="场景名称" />,
  )
  fireEvent.doubleClick(screen.getByRole('button', { name: '场景一' }))
  const input = screen.getByLabelText('场景名称') as HTMLInputElement
  input.focus()
  return { input, onChange }
}

const editing = () => screen.queryByLabelText('场景名称') !== null

/** 规范顺序的组合中间态：compositionstart 后的 input 事件带 isComposing。 */
function composeSteps(input: HTMLInputElement, steps: readonly string[]) {
  fireEvent.compositionStart(input)
  for (const step of steps) {
    fireEvent.input(input, { target: { value: step }, isComposing: true })
  }
}

describe('EditableName 输入法组合安全（issue #570）', () => {
  it('规范顺序：组合在途的 Enter 不提交、不退出编辑', () => {
    const { input, onChange } = openEditor()
    composeSteps(input, ['q', 'qi', 'qing'])
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(editing()).toBe(true)
    expect(input.value).toBe('qing')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('WebKit 乱序：compositionend 之后 keyCode 229 的 Enter 仍不提交，再按真实 Enter 才提交上屏文本', () => {
    const { input, onChange } = openEditor()
    composeSteps(input, ['q', 'qing'])
    fireEvent.input(input, { target: { value: '清' } })
    fireEvent.compositionEnd(input, { data: '清' })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    expect(editing()).toBe(true)
    expect(input.value).toBe('清')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('清')
    expect(editing()).toBe(false)
  })

  it('组合中的 Esc 只取消输入法合成，不放弃编辑；真实 Esc 才放弃', () => {
    const { input, onChange } = openEditor()
    fireEvent.input(input, { target: { value: '清明' } })
    composeSteps(input, ['j', 'jie'])
    fireEvent.keyDown(input, {
      key: 'Escape',
      isComposing: true,
      keyCode: 229,
    })
    expect(editing()).toBe(true)
    // 输入法随后清除标记文本并结束组合；WebKit 的晚到 Esc keydown 仅 keyCode 229
    fireEvent.input(input, { target: { value: '清明' } })
    fireEvent.compositionEnd(input, { data: '' })
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 })
    expect(editing()).toBe(true)
    expect(input.value).toBe('清明')
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 27 })
    expect(editing()).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '场景一' })).toBeTruthy()
  })

  it('非组合态的真实 Enter 提交一次（守卫不收窄既有语义）', () => {
    const { input, onChange } = openEditor()
    fireEvent.change(input, { target: { value: '新名' } })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('新名')
    expect(editing()).toBe(false)
  })
})
