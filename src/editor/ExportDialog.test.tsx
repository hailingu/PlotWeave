// @vitest-environment happy-dom
/**
 * 剧本导出对话框测试：标题/文件名/正文预览、导出范围概要、
 * 「创作大纲」开关与预览/复制/下载文本联动（issue #48）、
 * 无正文时的大纲引导、Esc 与遮罩关闭、复制成功态与剪贴板不可用的全选回退、
 * .md 下载触发。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import ExportDialog from './ExportDialog'
import type { ScriptExportModel } from './exportScript'

afterEach(cleanup)

/** 以可控桩替换剪贴板（happy-dom 无 clipboard 实现）。 */
function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
}

/** 导出模型夹具：正文与大纲两种全文，预览/复制/下载按开关取其一。 */
function model(over: Partial<ScriptExportModel> = {}): ScriptExportModel {
  return {
    plain: '# 正文\n第一场',
    outline: '# 正文\n第一场\n\n## 附录 · 创作大纲\n\n- 节拍 · 立势',
    hasNarrative: true,
    summary: {
      episodes: [1],
      scenes: 1,
      dialogues: 1,
      beats: 1,
      branches: 0,
      hasOutline: true,
    },
    scopeLine: '1 集 · 1 场 · 1 对白 · 1 节拍',
    ...over,
  }
}

function setup(props: { model?: ScriptExportModel; onClose?: () => void } = {}) {
  const onClose = props.onClose ?? vi.fn()
  render(<ExportDialog projectName="雨夜" model={props.model ?? model()} onClose={onClose} />)
  return { onClose }
}

/** 读取预览文本（pre 内容即当前导出文本）。 */
const preview = () => document.querySelector('.pw-export-pre')!.textContent
const outlineToggle = () => screen.getByRole('checkbox', { name: /创作大纲/ }) as HTMLInputElement

describe('ExportDialog（剧本导出对话框）', () => {
  beforeEach(() => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
  })

  it('标题、默认文件名、正文预览与导出范围概要就位', () => {
    setup()
    expect(screen.getByText('导出剧本')).toBeTruthy()
    expect(screen.getByText('雨夜-剧本.md')).toBeTruthy()
    expect(screen.getByText(/第一场/)).toBeTruthy()
    expect(screen.getByText('本次导出：1 集 · 1 场 · 1 对白 · 1 节拍')).toBeTruthy()
  })

  it('「创作大纲」默认关闭；开启后预览并入大纲附录，关闭后还原', () => {
    setup()
    expect(outlineToggle().checked).toBe(false)
    expect(preview()).not.toContain('附录 · 创作大纲')

    fireEvent.click(outlineToggle())
    expect(outlineToggle().checked).toBe(true)
    expect(preview()).toContain('附录 · 创作大纲')
    expect(preview()).toContain('节拍 · 立势')

    fireEvent.click(outlineToggle())
    expect(preview()).not.toContain('附录 · 创作大纲')
  })

  it('开启大纲后，复制与下载同样消费大纲全文（同一 text）', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    const createUrl = vi.fn().mockReturnValue('blob:mock')
    Object.defineProperty(URL, 'createObjectURL', { value: createUrl, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    setup()
    fireEvent.click(outlineToggle())
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    expect(writeText).toHaveBeenCalledWith(model().outline)
    fireEvent.click(screen.getByRole('button', { name: '下载 .md' }))
    expect(createUrl).toHaveBeenCalledTimes(1)
    expect((createUrl.mock.calls[0][0] as Blob).type).toBe('text/markdown;charset=utf-8')
    clickSpy.mockRestore()
  })

  it('复制成功后切换大纲开关即清除「已复制」态，不谎报剪贴板内容（review #81）', async () => {
    vi.useFakeTimers()
    try {
      const writeText = vi.fn().mockResolvedValue(undefined)
      stubClipboard(writeText)
      setup()
      fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByRole('button', { name: '✓ 已复制' })).toBeTruthy()

      // 1.6s 恢复计时未到就切换变体：按钮不得继续显示上一变体已复制
      fireEvent.click(outlineToggle())
      expect(screen.getByRole('button', { name: '复制全文' })).toBeTruthy()

      // 切回同样不恢复旧态
      fireEvent.click(outlineToggle())
      expect(screen.getByRole('button', { name: '复制全文' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('无正文时提示正文为空并引导开启大纲；开启后提示随态更新', () => {
    setup({ model: model({ plain: '# 空项目', outline: '# 空项目\n\n- 节拍 · 留白', hasNarrative: false }) })
    expect(screen.getByText(/正文为空（尚无场景与对白）/)).toBeTruthy()
    fireEvent.click(outlineToggle())
    expect(screen.getByText('正文 = 场景 + 对白；创作大纲与分镜卡为附录')).toBeTruthy()
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
