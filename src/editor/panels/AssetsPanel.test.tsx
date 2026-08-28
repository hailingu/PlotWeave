// @vitest-environment happy-dom
/**
 * 资产库面板组件测试：分类列表计数、类别内空态、缩略懒加载
 * （IntersectionObserver 触发 mediaUrl）、导入写库、行内改名与标签
 * 提交、删除确认（取消保留/确认移除并回收 blob URL）。
 * libraryStore 方法一律打桩，不触内存/IPC 实现。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import AssetsPanel from './AssetsPanel'
import { libraryStore, type LibraryAsset } from '../../library/libraryStore'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeAll(() => {
  // happy-dom 无 IntersectionObserver：桩为 observe 即触发回调
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(el: Element) {
        this.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as never)
      }
      unobserve() {}
      disconnect() {}
    },
  )
  if (typeof URL.revokeObjectURL !== 'function') {
    URL.revokeObjectURL = vi.fn()
  }
})

const asset = (over: Partial<LibraryAsset> = {}): LibraryAsset => ({
  id: 'a1',
  name: '女主正面',
  kind: 'character',
  view: 'front',
  mime: 'image/png',
  relPath: 'character/a1.png',
  tags: ['主角'],
  groupId: null,
  createdAt: 1,
  ...over,
})

function mockStore(list: LibraryAsset[]) {
  return {
    list: vi.spyOn(libraryStore, 'list').mockResolvedValue(list),
    put: vi.spyOn(libraryStore, 'put'),
    updateMeta: vi.spyOn(libraryStore, 'updateMeta').mockResolvedValue(asset()),
    remove: vi.spyOn(libraryStore, 'remove').mockResolvedValue(undefined),
    mediaUrl: vi.spyOn(libraryStore, 'mediaUrl').mockResolvedValue('blob:mock-url'),
  }
}

describe('AssetsPanel 分类列表', () => {
  it('按类别显示计数；进入类别；空类别显示引导', async () => {
    mockStore([asset(), asset({ id: 'a2', name: '男主侧面' })])
    render(<AssetsPanel />)
    // 角色设定 2 条，其余 0
    const charRow = (await screen.findByText('角色设定')).closest('.pw-assets-row')!
    expect(charRow.textContent).toContain('2')

    fireEvent.click(screen.getByTitle('查看服化道'))
    expect(await screen.findByText('暂无资产，点击「＋ 导入」添加参考图。')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '返回分类列表' }))
    expect(await screen.findByText('个人资产库 · 跨项目')).toBeTruthy()
  })
})

describe('AssetsPanel 类别内操作', () => {
  const enterCharacter = async () => {
    render(<AssetsPanel />)
    fireEvent.click(await screen.findByText('角色设定'))
    await screen.findByText('女主正面')
  }

  it('缩略懒加载：进入视口后取媒体 URL 渲染 img', async () => {
    const spies = mockStore([asset()])
    await enterCharacter()
    const img = (await screen.findByAltText('女主正面')) as HTMLImageElement
    expect(img.src).toBe('blob:mock-url')
    expect(spies.mediaUrl).toHaveBeenCalledWith(asset())
  })

  it('行内改名：本地列表更新并写库', async () => {
    const spies = mockStore([asset()])
    await enterCharacter()
    fireEvent.doubleClick(screen.getByRole('button', { name: '女主正面' }))
    const input = screen.getByRole('textbox', { name: '资产名 女主正面' })
    fireEvent.change(input, { target: { value: '女主微笑' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(spies.updateMeta).toHaveBeenCalledWith('a1', { name: '女主微笑' })
    expect(await screen.findByText('女主微笑')).toBeTruthy()
  })

  it('标签失焦提交：中英文逗号分隔、去空白、滤空', async () => {
    const spies = mockStore([asset()])
    await enterCharacter()
    const tags = screen.getByLabelText('资产标签 女主正面')
    fireEvent.change(tags, { target: { value: '主角， 现代 ,, 校服' } })
    fireEvent.blur(tags)
    expect(spies.updateMeta).toHaveBeenCalledWith('a1', { tags: ['主角', '现代', '校服'] })
  })

  it('删除需确认：取消保留、确认移除并回收 blob URL', async () => {
    const spies = mockStore([asset()])
    const confirmSpy = vi.fn(() => false)
    vi.stubGlobal('confirm', confirmSpy)
    await enterCharacter()
    await screen.findByAltText('女主正面') // 等懒加载给 urls 赋值

    fireEvent.click(screen.getByRole('button', { name: '删除资产 女主正面' }))
    expect(screen.getByText('女主正面')).toBeTruthy() // 取消：仍在
    expect(spies.remove).not.toHaveBeenCalled()

    confirmSpy.mockReturnValue(true)
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL')
    fireEvent.click(screen.getByRole('button', { name: '删除资产 女主正面' }))
    expect(screen.queryByText('女主正面')).toBeNull()
    expect(spies.remove).toHaveBeenCalledWith('a1')
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock-url')
  })
})

describe('AssetsPanel 导入', () => {
  it('选择文件逐个写库并追加到列表；busy 期间禁用导入按钮', async () => {
    const spies = mockStore([])
    spies.put.mockResolvedValue(asset({ id: 'a9', name: '新图.png', kind: 'other' }))
    render(<AssetsPanel />)
    await screen.findByText('个人资产库 · 跨项目')

    const input = document.querySelector('input[type=file]') as HTMLInputElement
    const file = new File(['x'], '新图.png', { type: 'image/png' })
    // happy-dom 的 files 只有 getter，fireEvent 的 target 注入写不进，直接定义属性
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)
    // 导入从分类列表发起：importKind 默认为 other，资产落「其他」类
    fireEvent.click(screen.getByText('其他'))
    expect(await screen.findByText('新图.png')).toBeTruthy()
    expect(spies.put).toHaveBeenCalledWith(file, 'other')
  })

  it('写库失败显示错误', async () => {
    const spies = mockStore([])
    spies.put.mockRejectedValue(new Error('磁盘满'))
    render(<AssetsPanel />)
    await screen.findByText('个人资产库 · 跨项目')
    const input = document.querySelector('input[type=file]') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'f.png')], configurable: true })
    fireEvent.change(input)
    expect(await screen.findByText(/磁盘满/)).toBeTruthy()
  })
})
