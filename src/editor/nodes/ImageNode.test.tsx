// @vitest-environment happy-dom
/**
 * 图片节点（生成侧媒体节点，§13）渲染测试：标题行徽标/尺寸、Prompt 预览、
 * 产物区三态（空态 / 生成图像 / 悬空引用占位）、作业状态角标、⚙️ 面板开关。
 * 组件经 NodeEditContext + ImageGenProvider 双上下文隔离渲染。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { NodeProps } from '@xyflow/react'
import { NodeEditContext, type NodeEditApi } from '../nodeEdit'
import { ImageGenProvider } from '../imagegen/ImageGenProvider'
import { projectAssets } from '../projectAssets'
import ImageNode from './ImageNode'
import type { AssetRef } from '../../model/document'
import type { CanvasNode, ImageFlowNode } from './types'

vi.mock('../projectAssets', () => ({
  projectAssets: {
    importFromLibrary: vi.fn(),
    mediaUrl: vi.fn().mockResolvedValue('asset://pa-1'),
  },
  tauriInvoke: vi.fn(),
  normalizeAssetRef: vi.fn(),
}))

afterEach(cleanup)

const asset: AssetRef = {
  id: 'pa-1',
  relPath: 'assets/pa-1.png',
  mime: 'image/png',
  source: 'generated',
  createdAt: '2026-09-04T08:00:00.000Z',
}

function setup(
  data: ImageFlowNode['data'],
  opts: { openSettingsId?: string | null; withAsset?: boolean } = {},
) {
  const api: NodeEditApi = {
    projectId: 'p-1',
    openSettingsId: opts.openSettingsId ?? null,
    toggleSettings: vi.fn(),
    closeSettings: vi.fn(),
    patchNode: vi.fn(),
    duplicateNode: vi.fn(),
    deleteNode: vi.fn(),
    shotCountOf: () => 0,
    beatFulfillmentOf: () => null,
    settings: { characters: [], locations: [] },
    assets: opts.withAsset === false ? undefined : { byId: { 'pa-1': asset } },
  }
  const nodesRef = { current: [] as CanvasNode[] }
  const props = { id: 'img1', data, selected: false } as unknown as NodeProps<ImageFlowNode>
  const view = render(
    <ImageGenProvider
      projectId="p-1"
      nodes={nodesRef.current}
      nodesRef={nodesRef}
      assetsRef={{ current: undefined }}
      settings={{ characters: [] }}
      applyDataPatch={vi.fn()}
      addAsset={vi.fn()}
      removeAsset={vi.fn()}
      pushHistory={vi.fn()}
    >
      <NodeEditContext.Provider value={api}>
        <ImageNode {...props} />
      </NodeEditContext.Provider>
    </ImageGenProvider>,
  )
  return { api, view }
}

const baseData = (): ImageFlowNode['data'] => ({
  prompt: '雨夜霓虹街道，中景',
  model: '',
  size: '1024x1536',
  outputs: {},
})

describe('图片节点渲染（§13）', () => {
  it('标题行徽标/尺寸 + Prompt 预览 + 空态占位', () => {
    setup(baseData())
    expect(screen.getByText('🖼 IMAGE')).toBeTruthy()
    expect(screen.getByText('1024x1536')).toBeTruthy()
    expect(screen.getByText('雨夜霓虹街道，中景')).toBeTruthy()
    expect(screen.getByText('尚未生成——⚙️ 配置 Prompt 后生成')).toBeTruthy()
  })

  it('空 Prompt 显示占位，不渲染空白段落', () => {
    setup({ ...baseData(), prompt: '' })
    expect(screen.getByText('（未填写 Prompt）')).toBeTruthy()
  })

  it('outputs.primary 有产物资产时渲染图像（媒体 URL 懒解析）', async () => {
    setup({ ...baseData(), outputs: { primary: { assetId: 'pa-1' } } })
    const img = await screen.findByRole('img')
    expect(img.getAttribute('src')).toBe('asset://pa-1')
  })

  it('产物资产在而媒体 URL 解析失败：显示可读失败占位，不静默空白', async () => {
    vi.mocked(projectAssets.mediaUrl).mockRejectedValueOnce(new Error('boom'))
    setup({ ...baseData(), outputs: { primary: { assetId: 'pa-1' } } })
    expect(await screen.findByText(/产物媒体无法读取/)).toBeTruthy()
  })

  it('URL 解析成功但图像解码失败（截断 PNG 等）：onError 转入失败占位', async () => {
    setup({ ...baseData(), outputs: { primary: { assetId: 'pa-1' } } })
    const img = await screen.findByRole('img')
    img.dispatchEvent(new window.Event('error'))
    expect(await screen.findByText(/产物媒体无法读取/)).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('primary 悬空（资产已删）显示缺失占位，不清除引用', () => {
    setup({ ...baseData(), outputs: { primary: { assetId: 'pa-1' } } }, { withAsset: false })
    expect(screen.getByText(/产物资产缺失/)).toBeTruthy()
  })

  it('⚙️ 展开设置面板（openSettingsId 命中时渲染 PROMPT 表单）', () => {
    setup(baseData(), { openSettingsId: 'img1' })
    expect(screen.getByLabelText('图片节点设置')).toBeTruthy()
    expect(screen.getByPlaceholderText(/角色定妆/)).toBeTruthy()
  })
})
