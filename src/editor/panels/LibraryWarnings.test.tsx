// @vitest-environment happy-dom
/** LibraryWarnings 展示（issue #135）：删除隔离区待清理状态对用户可见
 * （计数 + 影响 + 恢复指引），正常状态不误报，关闭后内容不变保持隐藏。
 * 待清理条目为结构化 { kind, message } 载荷（issue #229），呈现分区按
 * kind 而非文案。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

afterEach(cleanup)
beforeEach(() => {
  vi.resetModules()
})

const load = async () => {
  const diagnostics = await import('../../library/libraryDiagnostics')
  const { LibraryWarnings } = await import('./LibraryWarnings')
  return { diagnostics, LibraryWarnings }
}

const routine = (message: string) => ({ kind: 'routine', message })
const evidence = (message: string) => ({ kind: 'evidence', message })

describe('LibraryWarnings 删除隔离区待清理展示（issue #135）', () => {
  it('待清理状态可见：计数、影响（空间未释放）与恢复指引齐备', async () => {
    const { diagnostics, LibraryWarnings } = await load()
    diagnostics.publishCleanupPending(
      [
        routine('媒体已隔离待清理：assets/la-1.png'),
        routine('媒体已隔离待清理：assets/la-2.png'),
      ],
      '1',
    )
    render(<LibraryWarnings />)
    expect(screen.getByText(/删除隔离区待清理（2 项）/)).toBeTruthy()
    // 影响说明：不得把逻辑删除完成说成磁盘空间已回收
    expect(screen.getByText(/磁盘空间尚未释放/)).toBeTruthy()
    // 恢复指引：受限操作的恢复方式（清理 .trash + 同步日志）
    const guidance = screen.getByText(/恢复方式/)
    expect(guidance.textContent).toContain('.trash')
    expect(guidance.textContent).toContain('asset-delete-journal.json')
    // 明细条目随 details 可见
    expect(screen.getByText('媒体已隔离待清理：assets/la-1.png')).toBeTruthy()
  })

  it('无警告且无待清理时不渲染任何提示（正常状态不误报）', async () => {
    const { LibraryWarnings } = await load()
    const { container } = render(<LibraryWarnings />)
    expect(container.firstChild).toBeNull()
  })

  it('关闭后隐藏本轮提示；待清理内容变化时重新显示', async () => {
    const { diagnostics, LibraryWarnings } = await load()
    diagnostics.publishCleanupPending(
      [routine('媒体已隔离待清理：assets/la-1.png')],
      '2',
    )
    render(<LibraryWarnings />)
    fireEvent.click(screen.getByText('关闭图库提示'))
    expect(screen.queryByText(/删除隔离区待清理/)).toBeNull()
    act(() => {
      diagnostics.publishCleanupPending(
        [
          routine('媒体已隔离待清理：assets/la-1.png'),
          routine('媒体已隔离待清理：assets/la-2.png'),
        ],
        '3',
      )
    })
    expect(screen.getByText(/删除隔离区待清理（2 项）/)).toBeTruthy()
  })
})

describe('LibraryWarnings 冲突证据区（PR #222 评审 P1）', () => {
  it('仅 warnings 携带冲突时也不得给出目录级清理指引', async () => {
    const { diagnostics, LibraryWarnings } = await load()
    diagnostics.publishLibraryWarnings([
      '资产 la-conflict 删除事务冲突（原路径已被后来文件占用），标记为不可用',
    ])
    diagnostics.publishCleanupPending(
      [routine('媒体已隔离待清理：assets/la-1.png')],
      '4',
    )
    render(<LibraryWarnings />)
    expect(screen.queryByRole('note', { name: '隔离区清理指引' })).toBeNull()
    expect(screen.getByRole('note', { name: '隔离区清理暂停' })).toBeTruthy()
  })

  it('关闭冲突提示后待清理快照变化，不得解除目录级清理保护', async () => {
    const { diagnostics, LibraryWarnings } = await load()
    diagnostics.publishLibraryWarnings([
      '资产 la-conflict 删除事务冲突（隔离项身份不符），标记为不可用',
    ])
    render(<LibraryWarnings />)
    fireEvent.click(screen.getByRole('button', { name: '关闭图库提示' }))
    act(() => {
      diagnostics.publishLibraryWarnings([])
      diagnostics.publishCleanupPending(
        [routine('媒体已隔离待清理：assets/la-1.png')],
        '5',
      )
    })
    expect(screen.queryByRole('note', { name: '隔离区清理指引' })).toBeNull()
    expect(screen.getByRole('note', { name: '隔离区清理暂停' })).toBeTruthy()
  })

  it('证据类条目单独成区：明示保留现场、不含删除指引', async () => {
    const { diagnostics, LibraryWarnings } = await load()
    diagnostics.publishCleanupPending(
      [
        evidence('隔离项身份异常，保留现场待恢复：assets/la-3.png'),
        evidence('.trash/t-indexuncertain-1'),
      ],
      '6',
    )
    render(<LibraryWarnings />)
    expect(screen.getByText(/待人工核对的删除事务（2 项）/)).toBeTruthy()
    // 证据语义：仅存媒体与核对证据，禁止删除——不出现 .trash 清理指引
    const section = screen
      .getByText(/待人工核对的删除事务（2 项）/)
      .closest('details')!
    expect(section.textContent).toContain('请勿删除')
    expect(section.textContent).not.toContain('删除应用数据目录下')
    expect(section.textContent).not.toContain('恢复方式')
    // 常规清理区不得因纯证据条目出现（不误指可释放空间）
    expect(screen.queryByText(/删除隔离区待清理（/)).toBeNull()
  })

  it('常规与证据混合时两区并呈：目录级删除指引暂缓（PR #222 第二轮评审 P1）', async () => {
    const { diagnostics, LibraryWarnings } = await load()
    diagnostics.publishCleanupPending(
      [
        routine('媒体已隔离待清理：assets/la-1.png'),
        evidence('隔离项保留（身份不符或被占用）：la-4 / .trash/t-y'),
      ],
      '7',
    )
    render(<LibraryWarnings />)
    expect(screen.getByText(/删除隔离区待清理（1 项）/)).toBeTruthy()
    expect(screen.getByText(/待人工核对的删除事务（1 项）/)).toBeTruthy()
    // 混合态下 .trash 可能混有仍需保留的原媒体：常规区不得再给目录级
    // 删除指引，改为明示暂缓与恢复条件
    const routineSection = screen
      .getByText(/删除隔离区待清理（1 项）/)
      .closest('details')!
    expect(routineSection.textContent).not.toContain('删除应用数据目录下')
    expect(routineSection.textContent).toContain('暂缓')
  })

  it('分类不经文案（issue #229）：措辞/本地化变化不改变呈现分区', async () => {
    const { diagnostics, LibraryWarnings } = await load()
    // 验收：「媒体已隔离待清理：…」这一历史上的 routine 文案带 evidence
    // kind 时必须进入证据区——分类只读 kind，不推导自然语言
    diagnostics.publishCleanupPending(
      [evidence('媒体已隔离待清理：assets/la-1.png')],
      '8',
    )
    render(<LibraryWarnings />)
    expect(screen.getByText(/待人工核对的删除事务（1 项）/)).toBeTruthy()
    expect(screen.queryByText(/删除隔离区待清理（/)).toBeNull()
  })
})
