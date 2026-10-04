// @vitest-environment happy-dom
/** #504 共享媒体生命周期：URL/失败可见状态、身份切换和迟到结果隔离。 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectAssets } from '../projectAssets'
import { useAssetMedia } from './useAssetMedia'

vi.mock('../projectAssets', () => ({ projectAssets: { mediaUrl: vi.fn() } }))

afterEach(cleanup)
beforeEach(() => vi.mocked(projectAssets.mediaUrl).mockReset())

/** 受控外部请求，允许测试按实际完成顺序推进共享 hook。 */
function pendingMedia() {
  let resolve!: (url: string) => void
  let reject!: (error: Error) => void
  const promise = new Promise<string>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('媒体加载与失败恢复', () => {
  it('在途无旧 URL，成功后可显示；解码失败进入可见失败态', async () => {
    const request = pendingMedia()
    vi.mocked(projectAssets.mediaUrl).mockReturnValue(request.promise)
    const { result } = renderHook(() => useAssetMedia('project', 'asset'))
    expect(result.current.url).toBeNull()
    expect(result.current.failed).toBe(false)
    await act(async () => request.resolve('asset://current'))
    expect(result.current.url).toBe('asset://current')
    act(() => result.current.reportFailure())
    expect(result.current.failed).toBe(true)
  })

  it('读取拒绝可见，重挂载后重新加载并恢复', async () => {
    vi.mocked(projectAssets.mediaUrl).mockRejectedValueOnce(
      new Error('unreadable'),
    )
    const first = renderHook(() => useAssetMedia('project', 'asset'))
    await act(async () => {})
    expect(first.result.current.failed).toBe(true)
    expect(first.result.current.url).toBeNull()
    first.unmount()
    vi.mocked(projectAssets.mediaUrl).mockResolvedValueOnce('asset://recovered')
    const second = renderHook(() => useAssetMedia('project', 'asset'))
    await act(async () => {})
    expect(second.result.current.url).toBe('asset://recovered')
    expect(second.result.current.failed).toBe(false)
  })
})

describe('媒体资源身份与乱序完成', () => {
  it.each(['resolve', 'reject'] as const)(
    '换绑后旧请求迟到 %s 不覆盖当前资源',
    async (completion) => {
      const old = pendingMedia()
      vi.mocked(projectAssets.mediaUrl)
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce('asset://new')
      const { result, rerender } = renderHook(
        ({ assetId }) => useAssetMedia('project', assetId),
        { initialProps: { assetId: 'old' } },
      )
      rerender({ assetId: 'new' })
      await act(async () => {})
      expect(result.current.url).toBe('asset://new')
      await act(async () => {
        if (completion === 'resolve') old.resolve('asset://late')
        else old.reject(new Error('late failure'))
      })
      expect(result.current.url).toBe('asset://new')
      expect(result.current.failed).toBe(false)
    },
  )
})

describe('项目与挂载身份', () => {
  it('项目变化清旧 URL，同 id 资产重新加载', async () => {
    const first = pendingMedia()
    const second = pendingMedia()
    vi.mocked(projectAssets.mediaUrl)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { result, rerender } = renderHook(
      ({ projectId }) => useAssetMedia(projectId, 'same-asset'),
      { initialProps: { projectId: 'old-project' } },
    )
    await act(async () => first.resolve('asset://old-project'))
    rerender({ projectId: 'new-project' })
    expect(result.current.url).toBeNull()
    expect(result.current.failed).toBe(false)
    await act(async () => second.resolve('asset://new-project'))
    expect(result.current.url).toBe('asset://new-project')
  })

  it('旧项目请求迟到不能写回新项目的同 id 资产', async () => {
    const old = pendingMedia()
    vi.mocked(projectAssets.mediaUrl)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce('asset://new-project')
    const { result, rerender } = renderHook(
      ({ projectId }) => useAssetMedia(projectId, 'same-asset'),
      { initialProps: { projectId: 'old-project' } },
    )
    rerender({ projectId: 'new-project' })
    await act(async () => old.resolve('asset://old-project-late'))
    expect(result.current.url).toBe('asset://new-project')
    expect(result.current.failed).toBe(false)
  })

  it('相同资源重渲染不重取；卸载后完成的请求不污染新挂载', async () => {
    const old = pendingMedia()
    vi.mocked(projectAssets.mediaUrl)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce('asset://fresh')
    const first = renderHook(() => useAssetMedia('project', 'asset'))
    first.rerender()
    first.unmount()
    const second = renderHook(() => useAssetMedia('project', 'asset'))
    await act(async () => old.resolve('asset://stale'))
    expect(second.result.current.url).toBe('asset://fresh')
    expect(second.result.current.failed).toBe(false)
  })
})
