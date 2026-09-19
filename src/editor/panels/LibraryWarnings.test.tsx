// @vitest-environment happy-dom
/** LibraryWarnings 展示（issue #135）：删除隔离区待清理状态对用户可见
 * （计数 + 影响 + 恢复指引），正常状态不误报，关闭后内容不变保持隐藏。 */
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

describe('LibraryWarnings 删除隔离区待清理展示（issue #135）', () => {
  it('待清理状态可见：计数、影响（空间未释放）与恢复指引齐备', async () => {
    const { diagnostics, LibraryWarnings } = await load()
    diagnostics.publishCleanupPending([
      '媒体已隔离待清理：assets/la-1.png',
      '媒体已隔离待清理：assets/la-2.png',
    ])
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
    diagnostics.publishCleanupPending(['assets/la-1.png'])
    render(<LibraryWarnings />)
    fireEvent.click(screen.getByText('关闭图库提示'))
    expect(screen.queryByText(/删除隔离区待清理/)).toBeNull()
    act(() => {
      diagnostics.publishCleanupPending(['assets/la-1.png', 'assets/la-2.png'])
    })
    expect(screen.getByText(/删除隔离区待清理（2 项）/)).toBeTruthy()
  })
})
