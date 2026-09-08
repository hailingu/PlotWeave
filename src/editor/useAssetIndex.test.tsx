// @vitest-environment happy-dom
/**
 * 资产索引写入 hook（从 EditorWindow 搬迁，§7.3）：新增按 id 键控并入、
 * 移除只删索引条目；无资产桶时移除不改状态。
 */
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { useAssetIndex } from './useAssetIndex'
import type { AssetRef } from '../model/document'
import type { ProjectContent } from '../model/content'

const asset: AssetRef = {
  id: 'a1',
  relPath: 'assets/a1.png',
  mime: 'image/png',
  source: 'upload',
  createdAt: '2026-09-08T00:00:00.000Z',
}

function setup(initial: ProjectContent['assets']) {
  const { result } = renderHook(() => {
    const [assets, setAssets] = useState<ProjectContent['assets']>(initial)
    return { assets, actions: useAssetIndex(setAssets) }
  })
  return result
}

describe('useAssetIndex（§7.3 资产索引写入）', () => {
  it('addAsset 按键控并入，保留既有条目', () => {
    const result = setup({ byId: {} })
    act(() => result.current.actions.addAsset(asset))
    expect(result.current.assets?.byId).toEqual({ a1: asset })
  })

  it('无资产桶时 addAsset 也能建桶', () => {
    const result = setup(undefined)
    act(() => result.current.actions.addAsset(asset))
    expect(result.current.assets?.byId).toEqual({ a1: asset })
  })

  it('removeAsset 只删索引条目', () => {
    const result = setup({ byId: { a1: asset } })
    act(() => result.current.actions.removeAsset('a1'))
    expect(result.current.assets?.byId).toEqual({})
  })

  it('无资产桶时 removeAsset 保持 undefined', () => {
    const result = setup(undefined)
    act(() => result.current.actions.removeAsset('a1'))
    expect(result.current.assets).toBeUndefined()
  })
})
