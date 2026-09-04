// @vitest-environment happy-dom
/**
 * 图片节点 ⚙️ 表单的行为测试（§13 文生图）：字段编辑走 patchNode 命令；
 * 浏览器预览（无 IPC）下点「生成图片」得到明确失败文案而非静默无响应。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NodeEditContext, type NodeEditApi } from '../nodeEdit'
import { ImageGenProvider } from './ImageGenProvider'
import ImageNodeForm from '../nodes/settings/ImageNodeForm'
import type { CanvasNode, ImageFlowNode } from '../nodes/types'

vi.mock('../projectAssets', () => ({
  projectAssets: { importFromLibrary: vi.fn(), mediaUrl: vi.fn() },
  tauriInvoke: vi.fn(),
  normalizeAssetRef: vi.fn(),
}))

afterEach(cleanup)

function setup(data: ImageFlowNode['data']) {
  const patchNode = vi.fn()
  const api: NodeEditApi = {
    projectId: 'p-1',
    openSettingsId: 'img1',
    toggleSettings: vi.fn(),
    closeSettings: vi.fn(),
    patchNode,
    duplicateNode: vi.fn(),
    deleteNode: vi.fn(),
    shotCountOf: () => 0,
    beatFulfillmentOf: () => null,
    settings: { characters: [], locations: [] },
    assets: undefined,
  }
  const nodesRef = { current: [{ id: 'img1', type: 'image', data } as unknown as CanvasNode] }
  render(
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
        <ImageNodeForm node={{ id: 'img1', data }} />
      </NodeEditContext.Provider>
    </ImageGenProvider>,
  )
  return { patchNode }
}

describe('图片节点 ⚙️ 表单（§13 文生图）', () => {
  it('Prompt/尺寸编辑走 patchNode 命令（编辑即命令）', () => {
    const { patchNode } = setup({
      prompt: '旧描述',
      model: '',
      size: '1024x1024',
      outputs: {},
    })
    fireEvent.change(screen.getByPlaceholderText(/画面/), { target: { value: '新描述' } })
    expect(patchNode).toHaveBeenCalledWith('img1', { prompt: '新描述' })
    fireEvent.change(screen.getByLabelText(/尺寸/), { target: { value: '1536x1024' } })
    expect(patchNode).toHaveBeenCalledWith('img1', { size: '1536x1024' })
  })

  it('浏览器预览（无 IPC）下点生成：给出明确失败文案，不静默', async () => {
    setup({ prompt: '雨夜霓虹', model: '', size: '1024x1024', outputs: {} })
    fireEvent.click(screen.getByText('✦ 生成图片'))
    const err = await screen.findByText(/浏览器预览不支持图像生成/)
    expect(err).toBeTruthy()
  })
})
