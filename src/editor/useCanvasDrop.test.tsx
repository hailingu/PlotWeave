// @vitest-environment happy-dom
/**
 * 画布拖放 hook：设定集实体引用补丁（既有行为搬迁）+ 库资产拖上分镜卡
 * 拷贝进项目并绑定引用位（§7.3）。projectAssets 门面以 vi.mock 隔离。
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DragEvent as ReactDragEvent } from 'react'
import { PW_ENTITY_MIME, PW_LIBRARY_ASSET_MIME } from './dragDrop'
import { useCanvasDrop, type CanvasDropDeps } from './useCanvasDrop'
import { projectAssets } from './projectAssets'
import type { AssetRef } from '../model/document'
import type { CanvasNode } from './nodes/types'

vi.mock('./projectAssets', () => ({
  projectAssets: {
    importFromLibrary: vi.fn(),
    mediaUrl: vi.fn(),
    revalidate: vi.fn(),
  },
}))

const importMock = vi.mocked(projectAssets.importFromLibrary)
const revalidateMock = vi.mocked(projectAssets.revalidate)

afterEach(() => vi.clearAllMocks())

const shotNode = {
  id: 'sh1',
  type: 'shot',
  position: { x: 0, y: 0 },
  data: { shotNo: 1, size: '', picture: '', prompt: '', refs: [] },
} as unknown as CanvasNode

const sceneNode = {
  id: 'sc1',
  type: 'scene',
  position: { x: 0, y: 0 },
  data: { name: '场', sceneNo: 1, characterIds: [], locationId: null },
} as unknown as CanvasNode

const importedAsset: AssetRef = {
  id: 'pa-1',
  relPath: 'assets/pa-1.png',
  mime: 'image/png',
  source: 'upload',
  createdAt: '2026-09-04T08:00:00.000Z',
}

function setup(nodes: CanvasNode[] = [shotNode]) {
  const deps: CanvasDropDeps = {
    projectId: 'p-1',
    nodesRef: { current: nodes },
    patchNode: vi.fn(),
    applyDataPatch: vi.fn(),
    createNode: vi.fn(),
    screenToFlowPosition: (pos) => pos,
    addAsset: vi.fn(),
    removeAsset: vi.fn(),
    pushHistory: vi.fn(),
    onError: vi.fn(),
  }
  const { result } = renderHook(() => useCanvasDrop(deps))
  return { deps, handlers: result.current }
}

/** 构造 drop/dragOver 事件替身：target 经 closest 命中给定节点 id（null = 空白画布）。 */
const fakeEvent = (nodeId: string | null, types: string[], data: Record<string, string>) =>
  ({
    preventDefault: vi.fn(),
    dataTransfer: {
      types,
      getData: (t: string) => data[t] ?? '',
      dropEffect: '',
    },
    target: {
      closest: () => (nodeId === null ? null : { dataset: { id: nodeId } }),
    },
    clientX: 10,
    clientY: 20,
  }) as unknown as ReactDragEvent

const libPayload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ id: 'la-1', name: '林晚.png', kind: 'character', mime: 'image/png', ...over })

describe('useCanvasDrop：设定集实体路径（既有行为）', () => {
  it('实体拖上节点走 patchNode；空白处按实体预填生成场景', () => {
    const { deps, handlers } = setup([shotNode, sceneNode])
    const entity = JSON.stringify({ kind: 'character', id: 'ch1', name: '林晚' })
    handlers.onCanvasDrop(fakeEvent('sc1', [PW_ENTITY_MIME], { [PW_ENTITY_MIME]: entity }))
    expect(deps.patchNode).toHaveBeenCalledWith('sc1', { characterIds: ['ch1'] })

    handlers.onCanvasDrop(fakeEvent(null, [PW_ENTITY_MIME], { [PW_ENTITY_MIME]: entity }))
    expect(deps.createNode).toHaveBeenCalledWith('scene', {
      at: { x: 10, y: 20 },
      data: { characterIds: ['ch1'] },
    })
  })
})

describe('useCanvasDrop：库资产拖上分镜卡（§7.3 拷贝进项目）', () => {
  it('导入 → 资产入索引 + 引用位绑定 + 单条可撤销命令（undo 一并移除）', async () => {
    importMock.mockResolvedValue(importedAsset)
    const { deps, handlers } = setup()
    await act(async () => {
      handlers.onCanvasDrop(
        fakeEvent('sh1', [PW_LIBRARY_ASSET_MIME], { [PW_LIBRARY_ASSET_MIME]: libPayload() }),
      )
      await Promise.resolve()
    })
    expect(importMock).toHaveBeenCalledWith('p-1', 'la-1')
    expect(deps.addAsset).toHaveBeenCalledWith(importedAsset)
    const patch = vi.mocked(deps.applyDataPatch).mock.calls[0][1] as { refs: Array<{ assetId?: string; kind: string }> }
    expect(patch.refs).toHaveLength(1)
    expect(patch.refs[0]).toMatchObject({ kind: 'character', assetId: 'pa-1' })
    // 撤销单元：移除索引条目 + 还原引用位；重做恢复
    const cmd = vi.mocked(deps.pushHistory).mock.calls[0][0]
    act(() => cmd.undo())
    expect(deps.removeAsset).toHaveBeenCalledWith('pa-1')
    expect(vi.mocked(deps.applyDataPatch).mock.calls[1][1]).toEqual({ refs: [] })
    act(() => cmd.redo())
    expect(vi.mocked(deps.addAsset).mock.calls).toHaveLength(2)
    expect(vi.mocked(deps.applyDataPatch).mock.calls[2][1]).toEqual(patch)
  })

  it('重做防线（issue #10）：命令携带 redoGuard，重做前经 projectAssets.revalidate 复验', async () => {
    importMock.mockResolvedValue(importedAsset)
    const { deps, handlers } = setup()
    await act(async () => {
      handlers.onCanvasDrop(
        fakeEvent('sh1', [PW_LIBRARY_ASSET_MIME], { [PW_LIBRARY_ASSET_MIME]: libPayload() }),
      )
      await Promise.resolve()
    })
    const cmd = vi.mocked(deps.pushHistory).mock.calls[0][0]
    expect(cmd.redoGuard).toBeTypeOf('function')
    revalidateMock.mockResolvedValue(undefined)
    await act(async () => {
      await cmd.redoGuard?.()
    })
    expect(revalidateMock).toHaveBeenCalledWith('p-1', importedAsset)
  })

  it('非分镜卡目标与空白处不导入；kind/MIME 不支持经 onError 上浮且不导入', async () => {
    const { deps, handlers } = setup([shotNode, sceneNode])
    await act(async () => {
      handlers.onCanvasDrop(
        fakeEvent('sc1', [PW_LIBRARY_ASSET_MIME], { [PW_LIBRARY_ASSET_MIME]: libPayload() }),
      )
      handlers.onCanvasDrop(
        fakeEvent(null, [PW_LIBRARY_ASSET_MIME], { [PW_LIBRARY_ASSET_MIME]: libPayload() }),
      )
      await Promise.resolve()
    })
    expect(importMock).not.toHaveBeenCalled()

    await act(async () => {
      handlers.onCanvasDrop(
        fakeEvent('sh1', [PW_LIBRARY_ASSET_MIME], {
          [PW_LIBRARY_ASSET_MIME]: libPayload({ kind: 'other', mime: 'application/pdf' }),
        }),
      )
      await Promise.resolve()
    })
    expect(deps.onError).toHaveBeenCalled()
    expect(importMock).not.toHaveBeenCalled()
  })

  it('同一分镜卡导入在途期间的再次拖入被拒绝：不重复导入（无孤儿文件）、给出诊断', async () => {
    let resolveImport: (a: AssetRef) => void = () => {}
    importMock.mockImplementation(
      () =>
        new Promise<AssetRef>((r) => {
          resolveImport = r
        }),
    )
    const { deps, handlers } = setup()
    handlers.onCanvasDrop(
      fakeEvent('sh1', [PW_LIBRARY_ASSET_MIME], { [PW_LIBRARY_ASSET_MIME]: libPayload() }),
    )
    handlers.onCanvasDrop(
      fakeEvent('sh1', [PW_LIBRARY_ASSET_MIME], { [PW_LIBRARY_ASSET_MIME]: libPayload() }),
    )
    expect(importMock).toHaveBeenCalledTimes(1)
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('正在导入'))
    await act(async () => {
      resolveImport(importedAsset)
      await Promise.resolve()
    })
    expect(deps.addAsset).toHaveBeenCalledTimes(1)
    expect(deps.pushHistory).toHaveBeenCalledTimes(1)
  })

  it('导入返回的权威 MIME 与载荷推导的引用位不符时不绑定、不入索引', async () => {
    importMock.mockResolvedValue({ ...importedAsset, mime: 'audio/mpeg' })
    const { deps, handlers } = setup()
    await act(async () => {
      handlers.onCanvasDrop(
        fakeEvent('sh1', [PW_LIBRARY_ASSET_MIME], { [PW_LIBRARY_ASSET_MIME]: libPayload() }),
      )
      await Promise.resolve()
    })
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('不符'))
    expect(deps.addAsset).not.toHaveBeenCalled()
    expect(deps.applyDataPatch).not.toHaveBeenCalled()
    expect(deps.pushHistory).not.toHaveBeenCalled()
  })

  it('导入失败经 onError 上浮，不落绑定', async () => {
    importMock.mockRejectedValue(new Error('磁盘满'))
    const { deps, handlers } = setup()
    await act(async () => {
      handlers.onCanvasDrop(
        fakeEvent('sh1', [PW_LIBRARY_ASSET_MIME], { [PW_LIBRARY_ASSET_MIME]: libPayload() }),
      )
      await Promise.resolve()
    })
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('磁盘满'))
    expect(deps.addAsset).not.toHaveBeenCalled()
    expect(deps.pushHistory).not.toHaveBeenCalled()
  })

  it('dragOver 对实体与库资产两种 MIME 都放行 copy', () => {
    const { handlers } = setup()
    const over = (types: string[]) =>
      ({
        preventDefault: vi.fn(),
        dataTransfer: { types, dropEffect: '' },
      }) as unknown as ReactDragEvent
    const e1 = over([PW_ENTITY_MIME])
    const e2 = over([PW_LIBRARY_ASSET_MIME])
    const e3 = over(['text/plain'])
    handlers.onCanvasDragOver(e1)
    handlers.onCanvasDragOver(e2)
    handlers.onCanvasDragOver(e3)
    expect(e1.preventDefault).toHaveBeenCalled()
    expect(e2.preventDefault).toHaveBeenCalled()
    expect(e3.preventDefault).not.toHaveBeenCalled()
  })
})
