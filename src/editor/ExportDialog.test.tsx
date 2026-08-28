// @vitest-environment happy-dom
/**
 * 剧本导出对话框测试：标题/文件名/正文预览、Esc 与遮罩关闭、
 * 复制成功态与剪贴板不可用的全选回退、.md 下载触发。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import ExportDialog from './ExportDialog'

afterEach(cleanup)

/** 以可控桩替换剪贴板（happy-dom 无 clipboard 实现）。 */
function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
}

function setup(onClose = vi.fn()) {
  render(<ExportDialog projectName="雨夜" text={'# 正文\n第一场'} onClose={onClose} />)
  return { onClose }
}

describe('ExportDialog（剧本导出对话框）', () => {
  beforeEach(() => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
  })

  it('标题、默认文件名与正文预览就位', () => {
    setup()
    expect(screen.getByText('导出剧本')).toBeTruthy()
    expect(screen.getByText('雨夜-剧本.md')).toBeTruthy()
    expect(screen.getByText(/第一场/)).toBeTruthy()
  })

  it('Esc / 点击遮罩 / ✕ 按钮均关闭；对话框本体按下不穿透关闭', () => {
    const { onClose } = setup()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.pointerDown(screen.getByRole('button', { name: '关闭' }).closest('.pw-overlay')!)
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.pointerDown(screen.getByRole('dialog', { name: '导出剧本' }))
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('复制成功 → 按钮进入「✓ 已复制」态并限时恢复', async () => {
    vi.useFakeTimers()
    try {
      const writeText = vi.fn().mockResolvedValue(undefined)
      stubClipboard(writeText)
      setup()
      fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(writeText).toHaveBeenCalledWith('# 正文\n第一场')
      expect(screen.getByRole('button', { name: '✓ 已复制' })).toBeTruthy()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1700)
      })
      expect(screen.getByRole('button', { name: '复制全文' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('剪贴板不可用 → 回退为全选预览文本', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    setup()
    const selectSpy = vi.spyOn(window.getSelection()!, 'addRange')
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 850))
    })
    expect(selectSpy).toHaveBeenCalled()
    selectSpy.mockRestore()
  })

  it('下载 .md：Blob 建链触发 a.click 并回收 ObjectURL', () => {
    const createUrl = vi.fn().mockReturnValue('blob:mock')
    const revokeUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createUrl, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeUrl, configurable: true })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    setup()
    fireEvent.click(screen.getByRole('button', { name: '下载 .md' }))
    expect(createUrl).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(revokeUrl).toHaveBeenCalledWith('blob:mock')
    clickSpy.mockRestore()
  })
})
