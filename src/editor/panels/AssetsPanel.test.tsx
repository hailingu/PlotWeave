// @vitest-environment happy-dom
/**
 * 资产库面板组件测试：分类列表计数、类别内空态、缩略懒加载
 * （IntersectionObserver 触发 mediaUrl）、导入写库、行内改名与标签
 * 提交、删除确认（取消保留/确认移除并回收 blob URL）、标签提交状态
 * 同步（issue #124：保存同步/未变失焦/乱序迟到/失败保留/草稿保护/
 * 错误资产关联）。
 * libraryStore 方法一律打桩，不触内存/IPC 实现。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
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

/** 行内改名（#125）：双击进入编辑、Enter 确认后失焦退出编辑态。 */
const renameInline = async (from: string, to: string) => {
  fireEvent.doubleClick(screen.getByRole('button', { name: from }))
  const input = screen.getByRole('textbox', { name: `资产名 ${from}` })
  fireEvent.change(input, { target: { value: to } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.blur(input)
}

/** 进入角色分类并等待列表出现（测试辅助）。 */
const enterCharacter = async () => {
  render(<AssetsPanel />)
  fireEvent.click(await screen.findByText('角色设定'))
  await screen.findByText('女主正面')
}

describe('AssetsPanel 类别内操作', () => {
  it('缩略懒加载：进入视口后取媒体 URL 渲染 img', async () => {
    const spies = mockStore([asset()])
    await enterCharacter()
    const img = (await screen.findByAltText('女主正面')) as HTMLImageElement
    expect(img.src).toBe('blob:mock-url')
    expect(spies.mediaUrl).toHaveBeenCalledWith(asset())
  })

  it('标签失焦提交：中英文逗号分隔、去空白、滤空', async () => {
    const spies = mockStore([asset()])
    await enterCharacter()
    const tags = screen.getByLabelText('资产标签 女主正面')
    fireEvent.change(tags, { target: { value: '主角， 现代 ,, 校服' } })
    fireEvent.blur(tags)
    await act(async () => {}) // 提交链异步发起（PR #176 评审：串行化）
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

describe('AssetsPanel 行内改名', () => {
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

  it('行内改名失败：错误可见并回滚为已落盘名称（#125）', async () => {
    const spies = mockStore([asset()])
    vi.spyOn(libraryStore, 'persistedSnapshot').mockReturnValue(asset())
    spies.updateMeta.mockRejectedValueOnce(new Error('磁盘只读'))
    await enterCharacter()
    await renameInline('女主正面', '女主微笑')
    // 拒绝有可见反馈（错误横幅，与导入/列表错误同一展示位）
    expect(await screen.findByText('Error: 磁盘只读')).toBeTruthy()
    // 不把未落盘名称显示为已保存结果：回滚到最近已落盘基线
    expect(await screen.findByRole('button', { name: '女主正面' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '女主微笑' })).toBeNull()
  })

  it('改名失败后同资产重试成功解除错误（PR #180 评审）', async () => {
    const spies = mockStore([asset()])
    vi.spyOn(libraryStore, 'persistedSnapshot').mockReturnValue(asset())
    spies.updateMeta
      .mockRejectedValueOnce(new Error('磁盘只读'))
      .mockResolvedValueOnce(asset({ name: '女主微笑' }))
    await enterCharacter()
    await renameInline('女主正面', '女主微笑')
    expect(await screen.findByText('Error: 磁盘只读')).toBeTruthy()
    // 失败已回滚，重新发起同名改名并成功：错误随之解除
    await renameInline('女主正面', '女主微笑')
    expect(await screen.findByRole('button', { name: '女主微笑' })).toBeTruthy()
    await waitFor(() => expect(screen.queryByText(/磁盘只读/)).toBeNull())
  })
})

describe('AssetsPanel 行内改名代际守卫（PR #180 评审）', () => {
  it('被取代的迟到改名失败不回滚新意图（#125）', async () => {
    const spies = mockStore([asset()])
    vi.spyOn(libraryStore, 'persistedSnapshot').mockReturnValue(asset())
    let rejectFirst!: (err: Error) => void
    spies.updateMeta
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject
          }),
      )
      .mockResolvedValueOnce(asset({ name: '女主微笑2' }))
    await enterCharacter()
    // 第一次改名挂起未决，随后第二次改名（更新意图）成功
    await renameInline('女主正面', '女主微笑')
    await renameInline('女主微笑', '女主微笑2')
    expect(await screen.findByText('女主微笑2')).toBeTruthy()
    // 第一次的迟到失败不回滚、不上报：新意图已落盘，陈旧失败静默
    rejectFirst(new Error('磁盘只读'))
    await act(async () => {})
    expect(
      await screen.findByRole('button', { name: '女主微笑2' }),
    ).toBeTruthy()
    expect(screen.queryByText(/磁盘只读/)).toBeNull()
  })

  it('同名往返的迟到失败不按名称误判为当前意图（PR #180 评审）', async () => {
    const spies = mockStore([asset()])
    vi.spyOn(libraryStore, 'persistedSnapshot').mockReturnValue(asset())
    let rejectFirst!: (err: Error) => void
    spies.updateMeta
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject
          }),
      )
      .mockResolvedValueOnce(asset({ name: '女主微笑2' }))
      .mockResolvedValueOnce(asset({ name: '女主微笑' }))
    await enterCharacter()
    // A→B（挂起）→C→B：首个 B 请求的迟到失败与当前意图同名，代际判定
    // 不得按名称值误判——界面保持 B、不报错、不回滚到 A
    await renameInline('女主正面', '女主微笑')
    await renameInline('女主微笑', '女主微笑2')
    await renameInline('女主微笑2', '女主微笑')
    expect(await screen.findByRole('button', { name: '女主微笑' })).toBeTruthy()
    rejectFirst(new Error('磁盘只读'))
    await act(async () => {})
    expect(await screen.findByRole('button', { name: '女主微笑' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '女主正面' })).toBeNull()
    expect(screen.queryByText(/磁盘只读/)).toBeNull()
  })
})

describe('AssetsPanel 行内改名回滚基线（PR #180 评审）', () => {
  it('连续改名全失败时回滚到链条锚定的已落盘基线（PR #180 评审）', async () => {
    const spies = mockStore([asset()])
    // 本会话无快照：基线须锚定链条发起时的磁盘名，而非中途乐观值
    vi.spyOn(libraryStore, 'persistedSnapshot').mockReturnValue(undefined)
    let rejectFirst!: (err: Error) => void
    spies.updateMeta
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject
          }),
      )
      .mockRejectedValueOnce(new Error('磁盘只读'))
    await enterCharacter()
    await renameInline('女主正面', '女主微笑')
    await renameInline('女主微笑', '女主微笑2')
    // 第一次失败被取代（静默）；第二次失败按最新意图处理
    rejectFirst(new Error('第一次失败（被取代）'))
    await act(async () => {})
    // 回滚到锚定基线 女主正面（磁盘真值），而非乐观值 女主微笑
    expect(await screen.findByRole('button', { name: '女主正面' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '女主微笑' })).toBeNull()
    expect(screen.queryByRole('button', { name: '女主微笑2' })).toBeNull()
    expect(await screen.findByText('Error: 磁盘只读')).toBeTruthy()
  })

  it('面板重挂载后失败回滚到门面快照推进的基线（PR #180 评审）', async () => {
    const spies = mockStore([asset()])
    // 门面快照随旧实例排队写入的成功跨挂载推进（桩变量模拟）
    let persisted: LibraryAsset | undefined = asset()
    vi.spyOn(libraryStore, 'persistedSnapshot').mockImplementation(
      () => persisted,
    )
    let resolveFirst!: (v: LibraryAsset) => void
    let rejectSecond!: (err: Error) => void
    spies.updateMeta
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSecond = reject
          }),
      )
    await enterCharacter()
    await renameInline('女主正面', '女主微笑')
    // 切出资产 tab：面板卸载，新实例按列表读到 A（B 尚未落盘）并发起 C
    cleanup()
    await enterCharacter()
    await renameInline('女主正面', '女主微笑2')
    // 旧实例排队的 B 先成功：门面快照推进到 B（磁盘真值）
    resolveFirst(asset({ name: '女主微笑' }))
    persisted = asset({ name: '女主微笑' })
    // 新实例的 C 失败：回滚须取门面快照（B），不得用本地锚定的 A
    rejectSecond(new Error('磁盘只读'))
    await act(async () => {})
    expect(await screen.findByRole('button', { name: '女主微笑' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '女主正面' })).toBeNull()
    expect(screen.queryByRole('button', { name: '女主微笑2' })).toBeNull()
    expect(await screen.findByText('Error: 磁盘只读')).toBeTruthy()
  })
})

describe('AssetsPanel 删除终结重命名状态（PR #180 评审）', () => {
  it('改名失败后删除资产：错误随之解除不残留（PR #180 评审）', async () => {
    const spies = mockStore([asset()])
    vi.spyOn(libraryStore, 'persistedSnapshot').mockReturnValue(asset())
    spies.updateMeta.mockRejectedValueOnce(new Error('磁盘只读'))
    await enterCharacter()
    await renameInline('女主正面', '女主微笑')
    expect(await screen.findByText('Error: 磁盘只读')).toBeTruthy()
    // 确认删除该资产：已删资产的错误不得残留
    fireEvent.click(screen.getByRole('button', { name: '删除资产 女主正面' }))
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    expect(screen.queryByText('女主正面')).toBeNull()
    await waitFor(() => expect(screen.queryByText(/磁盘只读/)).toBeNull())
  })

  it('在途改名失败在删除资产后不得复活错误（PR #180 评审）', async () => {
    const spies = mockStore([asset()])
    vi.spyOn(libraryStore, 'persistedSnapshot').mockReturnValue(asset())
    let rejectRename!: (err: Error) => void
    spies.updateMeta.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRename = reject
        }),
    )
    await enterCharacter()
    await renameInline('女主正面', '女主微笑')
    // 确认删除后迟到的失败失效：不写错误、不回滚（行已不存在）
    fireEvent.click(screen.getByRole('button', { name: '删除资产 女主微笑' }))
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    rejectRename(new Error('磁盘只读'))
    await act(async () => {})
    expect(screen.queryByText(/磁盘只读/)).toBeNull()
  })
})

/** 进入角色分类并返回标签输入框（issue #124 测试辅助）。 */
const openTagsInput = async (): Promise<HTMLInputElement> => {
  render(<AssetsPanel />)
  fireEvent.click(await screen.findByText('角色设定'))
  return (await screen.findByLabelText('资产标签 女主正面')) as HTMLInputElement
}

describe('AssetsPanel 删除的标签错误隔离', () => {
  it('删除一个资产只清除其标签错误，另一资产错误仍可见', async () => {
    const spies = mockStore([asset(), asset({ id: 'a2', name: '男主侧面' })])
    spies.updateMeta.mockImplementation((id) =>
      Promise.reject(new Error(`${id} 保存失败`)),
    )
    const first = await openTagsInput()
    const second = screen.getByLabelText('资产标签 男主侧面')
    for (const input of [first, second]) {
      fireEvent.change(input, { target: { value: '新标签' } })
      fireEvent.blur(input)
    }
    await screen.findByText(/a1 保存失败.*a2 保存失败/)
    fireEvent.click(screen.getByRole('button', { name: '删除资产 女主正面' }))
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    await act(async () => {})
    expect(screen.queryByText(/a1 保存失败/)).toBeNull()
    expect(screen.getByText(/a2 保存失败/)).toBeTruthy()
    expect(screen.queryByLabelText('资产标签 女主正面')).toBeNull()
    expect(screen.getByLabelText('资产标签 男主侧面')).toBeTruthy()
  })
})

/** 返回分类列表再重进角色分类，返回重挂载后的标签输入框。 */
const roundTrip = async (): Promise<HTMLInputElement> => {
  fireEvent.click(screen.getByRole('button', { name: '返回分类列表' }))
  fireEvent.click(await screen.findByText('角色设定'))
  return (await screen.findByLabelText('资产标签 女主正面')) as HTMLInputElement
}

describe('AssetsPanel 标签提交：保存同步与未变失焦（issue #124）', () => {
  it('保存成功同步本地：重进分类显示新标签，未编辑失焦不再写库', async () => {
    const spies = mockStore([asset()])
    spies.updateMeta.mockImplementation((_id, patch) =>
      Promise.resolve(asset({ tags: patch.tags ?? [] })),
    )
    const tags = await openTagsInput()
    fireEvent.change(tags, { target: { value: '新标签' } })
    fireEvent.blur(tags)
    await act(async () => {}) // 等成功响应把已保存 tags 同步进本地列表
    expect(spies.updateMeta).toHaveBeenCalledWith('a1', { tags: ['新标签'] })

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

  it('零写入守卫咨询门面持久化快照：明确撤回才写入（PR #176 评审）', async () => {
    const spies = mockStore([asset()])
    // 跨挂载场景的组件侧投影：本地列表仍是 A，而门面快照（旧实例的
    // 成功落盘）已是 B——用户明确改回 A 时不能放行零写入
    vi.spyOn(libraryStore, 'persistedSnapshot').mockReturnValue(
      asset({ tags: ['B值'] }),
    )
    const tags = await openTagsInput()
    fireEvent.change(tags, { target: { value: '临时草稿' } })
    fireEvent.change(tags, { target: { value: '主角' } })
    fireEvent.blur(tags)
    await act(async () => {})
    expect(spies.updateMeta).toHaveBeenCalledWith('a1', { tags: ['主角'] })
  })
})

describe('AssetsPanel 标签提交：乱序与迟到响应（issue #124）', () => {
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

describe('AssetsPanel 标签提交：被取代成功与门面基线（PR #176 评审）', () => {
  it('被取代的成功推进门面基线：较新提交失败后的回退仍写库', async () => {
    const spies = mockStore([asset()])
    // 门面快照桩：真实门面在每次成功落盘时记录（含发起方实例已卸载），
    // 此处以变量在 B 成功时点同步快照，模拟跨挂载/被取代的基线推进
    let snapshot: LibraryAsset | undefined
    vi.spyOn(libraryStore, 'persistedSnapshot').mockImplementation(
      () => snapshot,
    )
    const resolvers: Array<(a: LibraryAsset) => void> = []
    let call = 0
    spies.updateMeta.mockImplementation(() => {
      call += 1
      if (call === 2) return Promise.reject(new Error('C 写入失败'))
      return new Promise<LibraryAsset>((res) => resolvers.push(res))
    })
    const tags = await openTagsInput()
    fireEvent.change(tags, { target: { value: 'B值' } })
    fireEvent.blur(tags) // seq1：B 排队
    fireEvent.change(tags, { target: { value: 'C值' } })
    fireEvent.blur(tags) // seq2：C 排队于 B 后
    await act(async () => {}) // 链发出 B（resolvers[0] 就绪）
    await act(async () => {
      resolvers[0](asset({ tags: ['B值'] })) // B 成功（门面记录基线）；C 随即失败
      snapshot = asset({ tags: ['B值'] })
    })
    expect(await screen.findByText(/C 写入失败/)).toBeTruthy()

    fireEvent.change(tags, { target: { value: '主角' } }) // 放弃 C 回退（本地仍 A）
    fireEvent.blur(tags)
    await act(async () => {})
    // 门面基线已是 B值：回退不得零写入放行，必须把 A 写回库
    expect(spies.updateMeta).toHaveBeenCalledTimes(3)
    expect(spies.updateMeta).toHaveBeenNthCalledWith(3, 'a1', {
      tags: ['主角'],
    })
  })
})

describe('AssetsPanel 标签提交：撤回保护（PR #176 评审）', () => {
  it('编辑中的撤回草稿不被迟到的保存响应抢占（响应先到）', async () => {
    const spies = mockStore([asset()])
    let resolveSave!: (a: LibraryAsset) => void
    spies.updateMeta.mockImplementation(
      () => new Promise<LibraryAsset>((res) => (resolveSave = res)),
    )
    const tags = await openTagsInput()
    fireEvent.change(tags, { target: { value: '新标签' } })
    fireEvent.blur(tags) // 提交「新标签」在途
    fireEvent.change(tags, { target: { value: '主角' } }) // 响应前改回旧值（撤回）
    await act(async () => {}) // 提交链发出第一次提交，resolveSave 就绪
    await act(async () => {
      resolveSave(asset({ tags: ['新标签'] }))
    })

    // 编辑中（dirty）：显示不被在途保存的结果抢占
    expect(tags.value).toBe('主角')
    fireEvent.blur(tags) // 撤回作为一次真实编辑提交
    await act(async () => {}) // 提交链异步发起
    expect(spies.updateMeta).toHaveBeenNthCalledWith(2, 'a1', {
      tags: ['主角'],
    })
  })

  it('在途提交目标不同时，回退失焦提交已保存值（回退先失焦）', async () => {
    const spies = mockStore([asset()])
    const resolvers: Array<(a: LibraryAsset) => void> = []
    spies.updateMeta.mockImplementation(
      () => new Promise<LibraryAsset>((res) => resolvers.push(res)),
    )
    const tags = await openTagsInput()
    fireEvent.change(tags, { target: { value: '新标签' } })
    fireEvent.blur(tags) // 提交「新标签」在途（resolvers[0]）
    fireEvent.change(tags, { target: { value: '主角' } })
    fireEvent.blur(tags) // 响应前回退失焦：本地 tags 仍是旧值
    await act(async () => {})
    // 组件立即把回退交给门面；真实 IPC 排序由 persistence 集成用例覆盖。
    expect(spies.updateMeta).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolvers[0](asset({ tags: ['新标签'] })) // 旧提交迟到落定
    })
    // 本地与显示不被旧提交覆盖：撤回已排队在其后发出
    expect(tags.value).toBe('主角')
    expect(spies.updateMeta).toHaveBeenCalledTimes(2)
    expect(spies.updateMeta).toHaveBeenNthCalledWith(2, 'a1', {
      tags: ['主角'],
    })

    await act(async () => {
      resolvers[1](asset({ tags: ['主角'] })) // 回退写回落定
    })
    const remounted = await roundTrip()
    expect(remounted.value).toBe('主角')
    fireEvent.blur(remounted)
    expect(spies.updateMeta).toHaveBeenCalledTimes(2)
  })
})

describe('AssetsPanel 标签提交：错误提示与解除（issue #124 评审）', () => {
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

  it('无写入的回退解除本资产的未解决失败（PR #176 评审）', async () => {
    const spies = mockStore([asset()])
    spies.updateMeta.mockRejectedValue(new Error('写入失败'))
    const tags = await openTagsInput()
    fireEvent.change(tags, { target: { value: '新标签' } })
    fireEvent.blur(tags) // 提交失败：错误行显示
    expect(await screen.findByText(/写入失败/)).toBeTruthy()
    fireEvent.change(tags, { target: { value: '主角' } }) // 放弃修改回退
    fireEvent.blur(tags)
    await act(async () => {})
    expect(screen.queryByText(/写入失败/)).toBeNull() // 回退 = 解除
    expect(spies.updateMeta).toHaveBeenCalledTimes(1) // 回退零写入
  })

  it('无关资产的成功不掩盖失败提示；失败资产重试成功后清除', async () => {
    const spies = mockStore([asset(), asset({ id: 'a2', name: '男主侧面' })])
    const calls: Record<string, number> = {}
    spies.updateMeta.mockImplementation((id, patch) => {
      calls[id] = (calls[id] ?? 0) + 1
      if (id === 'a1' && calls.a1 === 1) {
        return Promise.reject(new Error('a1 写入失败'))
      }
      return Promise.resolve(asset({ id, tags: patch.tags ?? [] }))
    })
    render(<AssetsPanel />)
    fireEvent.click(await screen.findByText('角色设定'))
    const t1 = (await screen.findByLabelText(
      '资产标签 女主正面',
    )) as HTMLInputElement
    const t2 = (await screen.findByLabelText(
      '资产标签 男主侧面',
    )) as HTMLInputElement

    fireEvent.change(t1, { target: { value: 'A新' } })
    fireEvent.blur(t1) // a1 首次提交失败
    expect(await screen.findByText(/a1 写入失败/)).toBeTruthy()
    fireEvent.change(t2, { target: { value: 'B新' } })
    fireEvent.blur(t2) // a2 成功：不得清除 a1 的失败提示
    await act(async () => {})
    expect(screen.getByText(/a1 写入失败/)).toBeTruthy()

    fireEvent.blur(t1) // a1 草稿保留，未编辑失焦即重试
    await act(async () => {})
    expect(screen.queryByText(/a1 写入失败/)).toBeNull()
    expect(spies.updateMeta).toHaveBeenCalledTimes(3)
  })
})

describe('AssetsPanel 标签提交：多资产与跨操作错误（PR #176 评审）', () => {
  it('按资产保留未解决错误：单个资产重试成功后其余失败仍显示', async () => {
    const spies = mockStore([asset(), asset({ id: 'a2', name: '男主侧面' })])
    const failIds = new Set(['a1', 'a2'])
    spies.updateMeta.mockImplementation((id, patch) =>
      failIds.has(id)
        ? Promise.reject(new Error(`${id} 写入失败`))
        : Promise.resolve(asset({ id, tags: patch.tags ?? [] })),
    )
    render(<AssetsPanel />)
    fireEvent.click(await screen.findByText('角色设定'))
    const t1 = (await screen.findByLabelText(
      '资产标签 女主正面',
    )) as HTMLInputElement
    const t2 = (await screen.findByLabelText(
      '资产标签 男主侧面',
    )) as HTMLInputElement

    fireEvent.change(t1, { target: { value: 'A新' } })
    fireEvent.blur(t1) // a1 失败
    expect(await screen.findByText(/a1 写入失败/)).toBeTruthy()
    fireEvent.change(t2, { target: { value: 'B新' } })
    fireEvent.blur(t2) // a2 也失败：横幅并示两资产错误
    expect(await screen.findByText(/a2 写入失败/)).toBeTruthy()
    expect(screen.getByText(/a1 写入失败/)).toBeTruthy()

    failIds.delete('a2') // a2 重试可成功
    fireEvent.blur(t2)
    await act(async () => {})
    // a2 的成功只解除自身：a1 未解决失败仍在横幅
    expect(screen.getByText(/a1 写入失败/)).toBeTruthy()
    expect(screen.queryByText(/a2 写入失败/)).toBeNull()

    failIds.delete('a1')
    fireEvent.blur(t1) // a1 最后重试成功：横幅清空
    await act(async () => {})
    expect(screen.queryByText(/a1 写入失败/)).toBeNull()
  })

  it('相同文案的错误分属两行互不误清', async () => {
    const spies = mockStore([asset()])
    spies.put.mockRejectedValue(new Error('磁盘满'))
    let call = 0
    spies.updateMeta.mockImplementation((_id, patch) => {
      call += 1
      return call === 1
        ? Promise.reject(new Error('磁盘满'))
        : Promise.resolve(asset({ tags: patch.tags ?? [] }))
    })
    render(<AssetsPanel />)
    fireEvent.click(await screen.findByText('角色设定'))
    const tags = (await screen.findByLabelText(
      '资产标签 女主正面',
    )) as HTMLInputElement
    fireEvent.change(tags, { target: { value: '新标签' } })
    fireEvent.blur(tags) // 标签失败：标签错误行显示
    expect(await screen.findAllByText(/磁盘满/)).toHaveLength(1)

    const file = document.querySelector('input[type=file]') as HTMLInputElement
    Object.defineProperty(file, 'files', {
      value: [new File(['x'], 'f.png')],
      configurable: true,
    })
    fireEvent.change(file) // 导入失败：共享错误行，同文案并示
    await waitFor(() => expect(screen.getAllByText(/磁盘满/)).toHaveLength(2))

    fireEvent.blur(tags) // 标签重试成功：仅清标签行，导入错误保留
    await act(async () => {})
    expect(screen.getAllByText(/磁盘满/)).toHaveLength(1)
    expect(spies.updateMeta).toHaveBeenCalledTimes(2)
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
