// @vitest-environment happy-dom
/**
 * 组合输入（IME）安全受控值（issue #42）：组合期间只在本地缓冲，结束才提交；
 * 非组合态保持「编辑即命令」逐键提交，外部值（撤销/重做、AI 补丁）回灌。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { useCompositionSafeValue } from './compositionValue'

afterEach(cleanup)

/** 受控宿主：提交回写外部状态，模拟「编辑即命令」的受控值链路。 */
function Host({
  onCommit,
  initial = '',
}: {
  readonly onCommit: (next: string) => void
  readonly initial?: string
}) {
  const [value, setValue] = useState(initial)
  const field = useCompositionSafeValue(value, (next) => {
    setValue(next)
    onCommit(next)
  })
  return (
    <>
      <input aria-label="字段" {...field} />
      <button type="button" onClick={() => setValue('外部值')}>
        外部写入
      </button>
    </>
  )
}

/** 模拟中文拼音上屏：组合期间的中间拼音 + 上屏文本 + compositionend。 */
function typePinyin(input: HTMLElement, pinyin: readonly string[], committed: string) {
  fireEvent.compositionStart(input)
  for (const step of pinyin) {
    fireEvent.input(input, { target: { value: step }, isComposing: true })
  }
  fireEvent.input(input, { target: { value: committed } })
  fireEvent.compositionEnd(input, { data: committed })
}

const field = () => screen.getByLabelText('字段') as HTMLInputElement

describe('useCompositionSafeValue', () => {
  it('非组合态逐键提交：编辑即命令不受影响', () => {
    const onCommit = vi.fn()
    render(<Host onCommit={onCommit} />)
    fireEvent.change(field(), { target: { value: 'qing' } })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('qing')
    expect(field().value).toBe('qing')
  })

  it('组合期间不提交；compositionend 只提交最终文本一次', () => {
    const onCommit = vi.fn()
    render(<Host onCommit={onCommit} />)
    const input = field()
    fireEvent.compositionStart(input)
    for (const step of ['q', 'qi', 'qin', 'qing']) {
      fireEvent.input(input, { target: { value: step }, isComposing: true })
    }
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.input(input, { target: { value: '清' } })
    fireEvent.compositionEnd(input, { data: '清' })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('清')
    expect(field().value).toBe('清')
  })

  it('组合期间的外部回写不覆盖输入中的文本', () => {
    const onCommit = vi.fn()
    render(<Host onCommit={onCommit} />)
    const input = field()
    fireEvent.compositionStart(input)
    fireEvent.input(input, { target: { value: 'qing' }, isComposing: true })
    fireEvent.click(screen.getByRole('button', { name: '外部写入' }))
    expect(field().value).toBe('qing')
    fireEvent.input(input, { target: { value: '清' } })
    fireEvent.compositionEnd(input, { data: '清' })
    expect(onCommit).toHaveBeenCalledWith('清')
  })

  it('非组合态的外部值回灌输入（撤销/重做、AI 补丁可见）', () => {
    render(<Host onCommit={vi.fn()} initial="初始" />)
    expect(field().value).toBe('初始')
    fireEvent.click(screen.getByRole('button', { name: '外部写入' }))
    expect(field().value).toBe('外部值')
  })

  it('上屏后的重复 input 事件不重复提交', () => {
    const onCommit = vi.fn()
    render(<Host onCommit={onCommit} />)
    typePinyin(field(), ['q', 'qi', 'qing'], '清')
    expect(onCommit).toHaveBeenCalledTimes(1)
    fireEvent.input(field(), { target: { value: '清' } })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })
})
