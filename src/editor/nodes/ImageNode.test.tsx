// @vitest-environment happy-dom
/**
 * 图片节点（生成侧媒体节点，§13）渲染测试：标题行徽标/尺寸、Prompt 预览、
 * 产物区三态（空态 / 生成图像 / 悬空引用占位）、作业状态角标、媒体加载
 * 失败占位接线（issue #131）。
 * ⚙️ 面板展开等外壳共享行为收敛至 nodeChrome.test.tsx 参数化维护
 * （issue #534）；NodeEditApi 夹具见 testScaffolding.tsx。
 * 组件经 NodeEditContext + ImageGenProvider 双上下文隔离渲染。
 * 换绑在途清空/乱序隔离/重挂载恢复自 issue #541 起仅在
 * useAssetMedia.test.tsx 断言；此处保留失败占位与换绑接线的集成用例
 * 及 onError 解码接线的 DOM 级断言（PR #561 评审）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { NodeProps } from '@xyflow/react'
import { NodeEditContext } from '../nodeEdit'
import { ImageGenProvider } from '../imagegen/ImageGenProvider'
import { projectAssets } from '../projectAssets'
import { makeNodeEditApi } from './testScaffolding'
import { ImageNode } from './ImageNode'
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
  opts: { withAsset?: boolean } = {},
) {
  const api = makeNodeEditApi({
    assets: opts.withAsset === false ? undefined : { byId: { 'pa-1': asset } },
  })
  const nodesRef = { current: [] as CanvasNode[] }
  const props = {
    id: 'img1',
    data,
    selected: false,
  } as unknown as NodeProps<ImageFlowNode>
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
    expect(screen.getByText('IMAGE')).toBeTruthy()
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

  // 媒体生命周期接线（issue #541）：三条生命周期规则在
  // useAssetMedia.test.tsx 断言，此处以失败占位集成用例证明 hook 状态
  // 到渲染的接线；onError 是组件自有的 DOM 事件接线，不随生命周期
  // 收敛，保留组件级断言（PR #561 评审 5512852009）。
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
    setup(
      { ...baseData(), outputs: { primary: { assetId: 'pa-1' } } },
      {
        withAsset: false,
      },
    )
    expect(screen.getByText(/产物资产缺失/)).toBeTruthy()
  })
})

/** 可重渲染的隔离渲染（换绑接线用例：同一产物位换 assetId）；换绑
 * 清旧图的组合契约（key 重挂载 + hook 清空兜底）见 OutputImage 文档。 */
function renderImageNode(
  assetId: string,
  byId: Record<string, AssetRef> = { 'pa-1': asset },
) {
  const api = makeNodeEditApi({ assets: { byId } })
  const nodesRef = { current: [] as CanvasNode[] }
  const props = (id: string) =>
    ({
      id: 'img1',
      data: { ...baseData(), outputs: { primary: { assetId: id } } },
      selected: false,
    }) as unknown as NodeProps<ImageFlowNode>
  const tree = (id: string) => (
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
        <ImageNode {...props(id)} />
      </NodeEditContext.Provider>
    </ImageGenProvider>
  )
  const view = render(tree(assetId))
  return { rerender: (id: string) => view.rerender(tree(id)) }
}

describe('产物区换绑接线（issue #131）', () => {
  // DOM 边界的换绑断言（PR #561 评审）：key 重挂载与清空在途旧图的
  // 组合接线归组件所有，不随生命周期规则收敛到 hook 层；hook 层仅能
  // 断言 effect 清空的状态语义。
  it('产物换绑：在途窗口清空旧图，不以 A 冒充 B', async () => {
    vi.mocked(projectAssets.mediaUrl)
      .mockResolvedValueOnce('asset://a')
      .mockImplementationOnce(() => new Promise(() => {}))
    const byId = {
      'pa-1': asset,
      'pa-2': { ...asset, id: 'pa-2', relPath: 'assets/pa-2.png' },
    }
    const { rerender } = renderImageNode('pa-1', byId)
    expect((await screen.findByRole('img')).getAttribute('src')).toBe(
      'asset://a',
    )
    rerender('pa-2')
    // 过渡窗口：B 在途，不得残留 A 的图
    expect(screen.queryByRole('img')).toBeNull()
  })
})
