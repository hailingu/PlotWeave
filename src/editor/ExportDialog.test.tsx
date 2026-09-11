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
import { buildScriptExport, type ScriptExportModel } from './exportScript'
import { buildCanvasNode } from './nodeFactory'
import { EMPTY_SETTINGS } from './settings'

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  vi.useRealTimers()
})

beforeEach(() => {
  stubClipboard(vi.fn().mockResolvedValue(undefined))
})

/** 以可控桩替换剪贴板（happy-dom 无 clipboard 实现）。 */
function stubClipboard(writeText: (text: string) => Promise<void>) {
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
  const view = render(<ExportDialog projectName="雨夜" model={props.model ?? model()} onClose={onClose} />)
  return { onClose, ...view }
}

/** 使用真实节点工厂与导出生成器核对可用性摘要到界面提示的完整链路。 */
function generatedModel(types: ReadonlyArray<Parameters<typeof buildCanvasNode>[0]>): ScriptExportModel {
  const nodes = types.map((type) => buildCanvasNode(type, undefined, { against: [], characters: [], center: null }))
  return buildScriptExport({
    projectName: '雨夜', nodes, edges: [], settings: EMPTY_SETTINGS,
    assets: undefined, episodeTitles: {},
  })
}

/** 读取预览文本（pre 内容即当前导出文本）。 */
const preview = () => document.querySelector('.pw-export-pre')!.textContent
const outlineToggle = () => screen.getByRole('checkbox', { name: /创作大纲/ }) as HTMLInputElement

describe('ExportDialog（无故事内容，review #81）', () => {
  it.each([
    ['空画布', []], ['只有分镜', ['shot']], ['只有图片', ['image']], ['分镜和图片', ['shot', 'image']],
  ] as const)('%s 在开关两态均显示空内容提示', (_, types) => {
    const draft = generatedModel(types)
    setup({ model: draft })
    expect(screen.getByText('暂无可导出的场景、对白、节奏或分支')).toBeTruthy()
    expect(preview()).toBe(draft.plain)
    fireEvent.click(outlineToggle())
    expect(screen.getByText('暂无可导出的场景、对白、节奏或分支')).toBeTruthy()
    expect(preview()).toBe(draft.outline)
  })

  it.each(['beat', 'branch'] as const)('仅有 %s 时仍引导开启有内容的大纲', (type) => {
    const draft = generatedModel([type])
    setup({ model: draft })
    expect(screen.getByText(/开启「创作大纲」可查看节奏与分支/)).toBeTruthy()
    fireEvent.click(outlineToggle())
    expect(screen.getByText('正文 = 场景 + 对白；创作大纲与分镜卡为附录')).toBeTruthy()
    expect(preview()).toBe(draft.outline)
    expect(preview()).toContain(type === 'beat' ? '新节拍' : '新的分岔是…？')
  })
})

describe('ExportDialog（内容可用性变化，review #81）', () => {
  it('新增内容、开启大纲、清空和恢复正文后，提示始终跟随当前模型', () => {
    const { rerender, onClose } = setup({ model: generatedModel([]) })
    rerender(<ExportDialog projectName="雨夜" model={generatedModel(['beat'])} onClose={onClose} />)
    expect(screen.getByText(/开启「创作大纲」可查看节奏与分支/)).toBeTruthy()
    fireEvent.click(outlineToggle())
    rerender(<ExportDialog projectName="雨夜" model={generatedModel([])} onClose={onClose} />)
    expect(outlineToggle().checked).toBe(true)
    expect(screen.getByText('暂无可导出的场景、对白、节奏或分支')).toBeTruthy()
    rerender(<ExportDialog projectName="雨夜" model={generatedModel(['scene'])} onClose={onClose} />)
    expect(screen.getByText('正文 = 场景 + 对白；创作大纲与分镜卡为附录')).toBeTruthy()
    fireEvent.click(outlineToggle())
    expect(screen.getByText('正文 = 场景 + 对白；分镜卡见附录')).toBeTruthy()
  })
})

/** 可控制完成时机的剪贴板替身；保留实际写入文本以核对回执与预览。 */
function pendingClipboard() {
  let value = ''
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  stubClipboard(async (text) => {
    await promise
    value = text
  })
  return { resolve, reject, read: () => value }
}

describe('ExportDialog（过期复制成功，review #81）', () => {
  it.each([false, true])('从大纲开关 %s 开始复制，切换后忽略旧成功回执', async (startOutline) => {
    vi.useFakeTimers()
    const clipboard = pendingClipboard()
    setup()
    if (startOutline) fireEvent.click(outlineToggle())
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    fireEvent.click(outlineToggle())
    await act(async () => clipboard.resolve())
    expect(clipboard.read()).toBe(startOutline ? model().outline : model().plain)
    expect(preview()).toBe(startOutline ? model().plain : model().outline)
    expect(screen.queryByRole('button', { name: '✓ 已复制' })).toBeNull()
  })

  it('复制期间切换再切回，也不接受上一轮的回执；重新复制可以成功', async () => {
    vi.useFakeTimers()
    const clipboard = pendingClipboard()
    setup()
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    fireEvent.click(outlineToggle())
    fireEvent.click(outlineToggle())
    await act(async () => clipboard.resolve())
    expect(screen.queryByRole('button', { name: '✓ 已复制' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(clipboard.read()).toBe(preview())
    expect(screen.getByRole('button', { name: '✓ 已复制' })).toBeTruthy()
  })
})

describe('ExportDialog（过期复制失败与重试，review #81）', () => {
  it.each(['reject', 'timeout'])('切换后旧请求 %s 不全选新预览', async (outcome) => {
    vi.useFakeTimers()
    const clipboard = pendingClipboard()
    setup()
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    fireEvent.click(outlineToggle())
    await act(async () => {
      if (outcome === 'reject') clipboard.reject(new Error('denied'))
      else await vi.advanceTimersByTimeAsync(850)
    })
    expect(window.getSelection()?.toString()).toBe('')
    expect(screen.queryByRole('button', { name: '✓ 已复制' })).toBeNull()
  })

  it('新复制失败后旧复制才成功，仍保留新尝试的手动复制回退', async () => {
    vi.useFakeTimers()
    const clipboard = pendingClipboard()
    setup()
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    stubClipboard(async () => { throw new Error('denied') })
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(window.getSelection()?.toString()).toBe(model().plain)
    await act(async () => clipboard.resolve())
    expect(screen.queryByRole('button', { name: '✓ 已复制' })).toBeNull()
    expect(window.getSelection()?.toString()).toBe(model().plain)
  })

  it('当前请求超时后全选当前预览，迟到成功不能恢复回执', async () => {
    vi.useFakeTimers()
    const clipboard = pendingClipboard()
    setup()
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(850) })
    expect(window.getSelection()?.toString()).toBe(model().plain)
    await act(async () => clipboard.resolve())
    expect(screen.queryByRole('button', { name: '✓ 已复制' })).toBeNull()
  })
})

describe('ExportDialog（复制与文本生命周期，review #81）', () => {
  it('导出模型更新后旧复制成功，不能给更新后的预览发回执', async () => {
    vi.useFakeTimers()
    const clipboard = pendingClipboard()
    const { rerender, onClose } = setup()
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    rerender(<ExportDialog projectName="雨夜" model={model({ plain: '# 新正文' })} onClose={onClose} />)
    await act(async () => clipboard.resolve())
    expect(preview()).toBe('# 新正文')
    expect(screen.queryByRole('button', { name: '✓ 已复制' })).toBeNull()
  })

  it('成功回执在导出文本更新时立即清除', async () => {
    vi.useFakeTimers()
    const { rerender, onClose } = setup()
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByRole('button', { name: '✓ 已复制' })).toBeTruthy()
    rerender(<ExportDialog projectName="雨夜" model={model({ plain: '# 新正文' })} onClose={onClose} />)
    expect(screen.queryByRole('button', { name: '✓ 已复制' })).toBeNull()
  })

  it('对话框关闭重开后，旧复制失败不选中新对话框的文本', async () => {
    vi.useFakeTimers()
    const clipboard = pendingClipboard()
    const { unmount } = setup()
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    unmount()
    setup({ model: model({ plain: '# 新对话框' }) })
    await act(async () => clipboard.reject(new Error('denied')))
    expect(window.getSelection()?.toString()).toBe('')
    expect(screen.queryByRole('button', { name: '✓ 已复制' })).toBeNull()
  })
})

describe('ExportDialog（剧本导出对话框）', () => {
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

})

describe('ExportDialog（复制回执与关闭）', () => {
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

})

describe('ExportDialog（剪贴板回退与下载）', () => {
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
