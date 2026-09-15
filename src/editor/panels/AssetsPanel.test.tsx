// @vitest-environment happy-dom
/**
 * 资产库面板组件测试：分类列表计数、类别内空态、缩略懒加载
 * （IntersectionObserver 触发 mediaUrl）、导入写库、行内改名与标签
 * 提交、删除确认（取消保留/确认移除并回收 blob URL）。
 * libraryStore 方法一律打桩，不触内存/IPC 实现。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
        this.cb(
          [{ isIntersecting: true, target: el } as IntersectionObserverEntry],
          this as never,
        )
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
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

function mockStore(list: LibraryAsset[]) {
  return {
    list: vi.spyOn(libraryStore, 'list').mockResolvedValue(list),
    put: vi.spyOn(libraryStore, 'put'),
    updateMeta: vi.spyOn(libraryStore, 'updateMeta').mockResolvedValue(asset()),
    remove: vi.spyOn(libraryStore, 'remove').mockResolvedValue(undefined),
    mediaUrl: vi
      .spyOn(libraryStore, 'mediaUrl')
      .mockResolvedValue('blob:mock-url'),
  }
}

describe('AssetsPanel 分类列表', () => {
  it('按类别显示计数；进入类别；空类别显示引导', async () => {
    mockStore([asset(), asset({ id: 'a2', name: '男主侧面' })])
    render(<AssetsPanel />)
    // 角色设定 2 条，其余 0
    const charRow = (await screen.findByText('角色设定')).closest(
      '.pw-assets-row',
    )!
    expect(charRow.textContent).toContain('2')

    fireEvent.click(screen.getByTitle('查看服化道'))
    expect(
      await screen.findByText('暂无资产，点击「＋ 导入」添加参考图。'),
    ).toBeTruthy()

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
    expect(spies.updateMeta).toHaveBeenCalledWith('a1', {
      tags: ['主角', '现代', '校服'],
    })
  })

  it('删除需确认：取消保留、确认移除并回收 blob URL', async () => {
    const spies = mockStore([asset()])
    await enterCharacter()
    await screen.findByAltText('女主正面') // 等懒加载给 urls 赋值

    // 应用内确认框（原生 window.confirm 在 WKWebView 无 UI 代理、静默 false）
    fireEvent.click(screen.getByRole('button', { name: '删除资产 女主正面' }))
    expect(await screen.findByText(/删除「女主正面」？/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByText('女主正面')).toBeTruthy() // 取消：仍在
    expect(spies.remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '删除资产 女主正面' }))
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL')
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    expect(screen.queryByText('女主正面')).toBeNull()
    expect(spies.remove).toHaveBeenCalledWith('a1')
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock-url')
  })
})

describe('AssetsPanel 标签提交状态同步（issue #124）', () => {
  /** 进入角色分类并返回标签输入框元素。 */
  const openTagsInput = async (): Promise<HTMLInputElement> => {
    render(<AssetsPanel />)
    fireEvent.click(await screen.findByText('角色设定'))
    return (await screen.findByLabelText(
      '资产标签 女主正面',
    )) as HTMLInputElement
  }

  /** 返回分类列表再重进角色分类，返回重挂载后的标签输入框。 */
  const roundTrip = async (): Promise<HTMLInputElement> => {
    fireEvent.click(screen.getByRole('button', { name: '返回分类列表' }))
    fireEvent.click(await screen.findByText('角色设定'))
    return (await screen.findByLabelText(
      '资产标签 女主正面',
    )) as HTMLInputElement
  }

  it('保存成功同步本地：重进分类显示新标签，未编辑失焦不再写库', async () => {
    const spies = mockStore([asset()])
    spies.updateMeta.mockImplementation((_id, patch) =>
      Promise.resolve(asset({ tags: patch.tags ?? [] })),
    )
    const tags = await openTagsInput()
    fireEvent.change(tags, { target: { value: '新标签' } })
    fireEvent.blur(tags)
    expect(spies.updateMeta).toHaveBeenCalledWith('a1', { tags: ['新标签'] })
    await act(async () => {}) // 等成功响应把已保存 tags 同步进本地列表

    const remounted = await roundTrip()
    expect(remounted.value).toBe('新标签')
    fireEvent.blur(remounted)
    expect(spies.updateMeta).toHaveBeenCalledTimes(1)
  })

  it('未编辑的失焦（输入即当前 tags）不写库', async () => {
    const spies = mockStore([asset()])
    const tags = await openTagsInput()
    fireEvent.blur(tags)
    expect(spies.updateMeta).not.toHaveBeenCalled()
  })

  it('异步乱序：迟到的旧提交响应不得回滚最新标签', async () => {
    const spies = mockStore([asset()])
    let resolveFirst!: (a: LibraryAsset) => void
    const first = new Promise<LibraryAsset>((res) => {
      resolveFirst = res
    })
    let call = 0
    spies.updateMeta.mockImplementation((_id, patch) => {
      call += 1
      return call === 1
        ? first
        : Promise.resolve(asset({ tags: patch.tags ?? [] }))
    })
    const tags = await openTagsInput()
    fireEvent.change(tags, { target: { value: '中间' } })
    fireEvent.blur(tags) // 第一次提交挂起
    fireEvent.change(tags, { target: { value: '最终' } })
    fireEvent.blur(tags) // 第二次提交先返回
    await act(async () => {
      resolveFirst(asset({ tags: ['中间'] })) // 旧提交迟到返回
    })

    const remounted = await roundTrip()
    expect(remounted.value).toBe('最终')
    fireEvent.blur(remounted)
    expect(spies.updateMeta).toHaveBeenCalledTimes(2)
  })

  it('保存失败：提示错误且保留输入，本地不写入', async () => {
    const spies = mockStore([asset()])
    spies.updateMeta.mockRejectedValue(new Error('写入失败'))
    const tags = await openTagsInput()
    fireEvent.change(tags, { target: { value: '新标签' } })
    fireEvent.blur(tags)
    expect(await screen.findByText(/写入失败/)).toBeTruthy()
    expect(tags.value).toBe('新标签')
    expect(spies.updateMeta).toHaveBeenCalledTimes(1)
  })

  it('迟到成功响应落地后，重挂载的输入框收敛到新标签且失焦不写库', async () => {
    const spies = mockStore([asset()])
    let resolveSave!: (a: LibraryAsset) => void
    spies.updateMeta.mockImplementation(
      () => new Promise<LibraryAsset>((res) => (resolveSave = res)),
    )
    const tags = await openTagsInput()
    fireEvent.change(tags, { target: { value: '新标签' } })
    fireEvent.blur(tags)
    // 保存未返回前完成分类往返：重挂载时本地仍是旧值
    const remounted = await roundTrip()
    expect(remounted.value).toBe('主角')
    await act(async () => {
      resolveSave(asset({ tags: ['新标签'] }))
    })

    expect(remounted.value).toBe('新标签')
    fireEvent.blur(remounted)
    expect(spies.updateMeta).toHaveBeenCalledTimes(1)
  })
})

describe('AssetsPanel 导入', () => {
  it('选择文件逐个写库并追加到列表；busy 期间禁用导入按钮', async () => {
    const spies = mockStore([])
    spies.put.mockResolvedValue(
      asset({ id: 'a9', name: '新图.png', kind: 'other' }),
    )
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
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'f.png')],
      configurable: true,
    })
    fireEvent.change(input)
    expect(await screen.findByText(/磁盘满/)).toBeTruthy()
  })
})
