// @vitest-environment happy-dom
/** JSON 格式切换、实际交付内容及失败恢复：外部剪贴板/下载边界使用可读替身。 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExportDialog } from './ExportDialog'
import { buildScriptExport } from './exportScript'
import { EMPTY_SETTINGS } from './settings'

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** 当前格式在三个交付入口共用的 JSON 文本；格式契约由浮层集成测试覆盖。 */
const JSON_TEXT = '{\n  "schemaVersion": 1,\n  "project": { "name": "雨夜" }\n}'

/** 渲染真实生成的 Markdown 模型与独立 JSON 文本。 */
function setup() {
  const model = buildScriptExport({
    projectName: '雨夜',
    nodes: [],
    edges: [],
    settings: EMPTY_SETTINGS,
    assets: undefined,
    episodeTitles: {},
  })
  return render(
    <ExportDialog
      projectName="雨夜"
      model={model}
      json={JSON_TEXT}
      onClose={() => {}}
    />,
  )
}

/** 用户通过有标签的格式选择器切换当前导出文本。 */
function selectFormat(format: 'md' | 'json') {
  fireEvent.change(screen.getByRole('combobox', { name: '导出格式' }), {
    target: { value: format },
  })
}

/** 当前预览是复制与下载必须逐字保持的用户可见内容。 */
function preview() {
  return document.querySelector('.pw-export-pre')?.textContent
}

/** 系统剪贴板边界替身：实际记录完成的写入结果。 */
function clipboardWith(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
}

/** 下载边界替身：记录实际 Blob、下载文件名及 URL 资源释放状态。 */
function downloadTarget(fail = false) {
  let blob: Blob | undefined
  let name = ''
  let released = false
  let failed = fail
  vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
    blob = value as Blob
    return 'blob:json-export'
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
    released = true
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    if (failed) throw new Error('下载受限')
    name = this.download
  })
  return {
    result: () => ({ blob, name, released }),
    allow: () => {
      failed = false
    },
  }
}

describe('JSON 导出的格式与交付', () => {
  // 删除格式分支或继续使用 Markdown 文本/MIME，会破坏可见预览或实际交付结果。
  it('切到 JSON 后预览、剪贴板、下载文件字节与类型一致', async () => {
    let clipboard = ''
    clipboardWith(async (text) => {
      clipboard = text
    })
    const target = downloadTarget()
    setup()
    selectFormat('json')
    expect(preview()).toBe(JSON_TEXT)
    expect(screen.getByText('雨夜-剧本.json')).toBeTruthy()
    expect(screen.queryByText('本次导出：空画布')).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /创作大纲/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: '下载 .json' }))
    expect(clipboard).toBe(JSON_TEXT)
    expect(await target.result().blob?.text()).toBe(JSON_TEXT)
    expect(target.result()).toMatchObject({
      name: '雨夜-剧本.json',
      released: true,
    })
    expect(target.result().blob?.type).toBe('application/json;charset=utf-8')
  })

  it('回到 Markdown 时保留原大纲选择与文本', () => {
    setup()
    fireEvent.click(screen.getByRole('checkbox', { name: /创作大纲/ }))
    const markdown = preview()
    selectFormat('json')
    selectFormat('md')
    expect(preview()).toBe(markdown)
    expect(
      (screen.getByRole('checkbox', { name: /创作大纲/ }) as HTMLInputElement)
        .checked,
    ).toBe(true)
  })
})

describe('JSON 导出的复制与失败恢复', () => {
  // 不失效旧代次时，旧请求会误报新格式已复制或选中新预览。
  it.each(['success', 'failure', 'timeout'] as const)(
    '格式切换使旧复制 %s 结果失效',
    async (outcome) => {
      vi.useFakeTimers()
      let resolve!: () => void
      let reject!: (error: Error) => void
      clipboardWith(
        () =>
          new Promise<void>((done, fail) => {
            resolve = done
            reject = fail
          }),
      )
      setup()
      fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
      selectFormat('json')
      await act(async () => {
        if (outcome === 'success') resolve()
        else if (outcome === 'failure') reject(new Error('拒绝'))
        else await vi.advanceTimersByTimeAsync(850)
      })
      expect(preview()).toBe(JSON_TEXT)
      expect(screen.queryByRole('button', { name: '✓ 已复制' })).toBeNull()
      expect(window.getSelection()?.toString()).toBe('')
    },
  )

  it('无剪贴板 API 时全选当前 JSON，随后可重试复制', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    })
    setup()
    selectFormat('json')
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    await act(async () => {})
    expect(window.getSelection()?.toString()).toBe(JSON_TEXT)
    let clipboard = ''
    clipboardWith(async (text) => {
      clipboard = text
    })
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    await act(async () => {})
    expect(clipboard).toBe(JSON_TEXT)
    expect(screen.getByRole('button', { name: '✓ 已复制' })).toBeTruthy()
  })

  it('下载失败显示诊断并释放 URL，重试成功后清除诊断', () => {
    const target = downloadTarget(true)
    setup()
    selectFormat('json')
    fireEvent.click(screen.getByRole('button', { name: '下载 .json' }))
    expect(screen.getByRole('alert').textContent).toContain('下载受限')
    expect(target.result().released).toBe(true)
    target.allow()
    fireEvent.click(screen.getByRole('button', { name: '下载 .json' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(target.result().name).toBe('雨夜-剧本.json')
  })
})
