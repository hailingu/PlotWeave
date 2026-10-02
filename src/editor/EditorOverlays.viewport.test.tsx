// @vitest-environment happy-dom
/** 真实 React Flow 定位动画落定后，JSON 预览与复制、下载、保存共享最新视口。 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from './EditorView'
import type { EditorProjectContent } from './useEditorDocument'
import type { ProjectContent } from '../model/content'
import type { Viewport } from '@xyflow/react'
import type { CanvasNode } from './nodes/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** 预设框架支持的节点尺寸与端口，避免无布局 DOM 依赖浏览器几何测量。 */
function project(): EditorProjectContent {
  const nodes: CanvasNode[] = [
    {
      id: 'scene',
      type: 'scene',
      position: { x: 600, y: 400 },
      width: 340,
      height: 200,
      measured: { width: 340, height: 200 },
      handles: [],
      data: {
        name: '天台',
        sceneNo: 1,
        interior: false,
        time: '夜',
        synopsis: '',
        characterIds: [],
      },
    },
  ]
  return {
    id: 'viewport-export',
    name: '视口导出',
    nodes,
    edges: [],
    settings: { characters: [], locations: [] },
    viewport: { x: 10, y: 20, zoom: 0.5 },
  }
}

/** 从框架实际绘制的 CSS 变换读取结果，与应用序列化实现独立。 */
function canvasViewport(container: HTMLElement): Viewport {
  const transform = container.querySelector<HTMLElement>(
    '.react-flow__viewport',
  )?.style.transform
  const values = transform?.match(
    /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/,
  )
  if (!values) throw new Error(`缺失有效画布变换：${transform}`)
  return { x: Number(values[1]), y: Number(values[2]), zoom: Number(values[3]) }
}

/** 通过真实标题栏开启 JSON 导出，不重新挂载编辑器或手工刷新模型。 */
function openJson(): void {
  fireEvent.click(screen.getByRole('button', { name: '导出剧本' }))
  fireEvent.change(screen.getByRole('combobox', { name: '导出格式' }), {
    target: { value: 'json' },
  })
}

/** 当前用户可见 JSON 文本。 */
function preview(): string {
  const text = document.querySelector('.pw-export-pre')?.textContent
  if (!text) throw new Error('缺失 JSON 预览')
  return text
}

/** 系统 I/O 边界收集真实交付字节；编辑器、动画与导出器均使用生产实现。 */
function deliveryTargets() {
  let clipboard = ''
  let download: Blob | undefined
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        clipboard = text
      },
    },
  })
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    download = blob as Blob
    return 'blob:viewport-export'
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return { clipboard: () => clipboard, download: () => download }
}

/** 从用户触发定位到导出打开不推进动画，复现完成事件晚于模型建立的顺序。 */
function locateThenExport() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 1000, 700),
  )
  const saved: ProjectContent[] = []
  const { container } = render(
    <EditorView
      project={project()}
      onBackHome={() => {}}
      onRenameProject={() => {}}
      onSave={(content) => {
        saved.push(content)
      }}
    />,
  )
  const initialViewport = canvasViewport(container)
  fireEvent.click(
    within(screen.getByLabelText('故事大纲')).getByText('场 01 · 天台'),
  )
  openJson()
  expect(JSON.parse(preview()).graph.viewport).toEqual(initialViewport)
  return { container, saved, initialViewport }
}

describe('导出打开期间的视口落定（PR #489 评审）', () => {
  it('大纲定位动画晚于导出打开完成，预览和交付结果与最终保存视口一致', async () => {
    const targets = deliveryTargets()
    const { container, saved, initialViewport } = locateThenExport()
    await waitFor(
      () => expect(saved[saved.length - 1]?.viewport).toBeDefined(),
      {
        timeout: 2500,
      },
    )
    const finalViewport = canvasViewport(container)
    expect(finalViewport).not.toEqual(initialViewport)
    expect(saved[saved.length - 1]?.viewport).toEqual(finalViewport)
    expect(JSON.parse(preview()).graph.viewport).toEqual(finalViewport)
    const text = preview()
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: '下载 .json' }))
    expect(targets.clipboard()).toBe(text)
    expect(await targets.download()?.text()).toBe(text)
  })

  it('关闭期间动画完成，再次打开采用完成视口', async () => {
    const { container, saved } = locateThenExport()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(document.querySelector('.pw-export-pre')).toBeNull()
    await waitFor(
      () => expect(saved[saved.length - 1]?.viewport).toBeDefined(),
      {
        timeout: 2500,
      },
    )
    openJson()
    expect(JSON.parse(preview()).graph.viewport).toEqual(
      canvasViewport(container),
    )
    expect(JSON.parse(preview()).graph.viewport).toEqual(
      saved[saved.length - 1]?.viewport,
    )
  })
})

describe('视口变化使旧复制代次失效', () => {
  it('动画完成后旧复制成功不会给新 JSON 显示已复制，新请求可正常完成', async () => {
    let finishCopy!: () => void
    let copied = ''
    const firstCopy = new Promise<void>((resolve) => {
      finishCopy = resolve
    })
    const writeText = vi.fn(async (text: string) => {
      copied = text
    })
    writeText.mockImplementationOnce(() => firstCopy)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { initialViewport, container } = locateThenExport()
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    await waitFor(
      () => {
        expect(JSON.parse(preview()).graph.viewport).not.toEqual(
          initialViewport,
        )
      },
      { timeout: 2500 },
    )
    expect(JSON.parse(preview()).graph.viewport).toEqual(
      canvasViewport(container),
    )
    await act(async () => {
      finishCopy()
      await firstCopy
    })
    expect(screen.queryByRole('button', { name: '✓ 已复制' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }))
    await act(async () => {})
    expect(copied).toBe(preview())
    expect(screen.getByRole('button', { name: '✓ 已复制' })).toBeTruthy()
  })
})
