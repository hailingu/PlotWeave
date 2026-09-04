// @vitest-environment happy-dom
/**
 * 分镜卡（监视器卡）渲染测试：SHOT 编号/景别标题行、画面描述、
 * 镜头 Prompt、引用位 chip（角色垫图/场景底图/音频图标）、⚙️ 面板开关。
 * Handle 依赖 React Flow 仓库上下文，隔离渲染时以锚点桩替代。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { NodeProps } from '@xyflow/react'
import { NodeEditContext, type NodeEditApi } from '../nodeEdit'
import ShotNode from './ShotNode'
import type { ShotFlowNode } from './types'

vi.mock('../projectAssets', () => ({
  projectAssets: {
    importFromLibrary: vi.fn(),
    mediaUrl: vi.fn(),
  },
}))

vi.mock('@xyflow/react', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...orig,
    /** Handle 桩：脱离 ReactFlow 画布后仅保留锚点语义（type/id）供断言。 */
    Handle: (props: { readonly id?: string; readonly type: string }) => (
      <div data-testid={`handle-${props.type}${props.id ? `-${props.id}` : ''}`} />
    ),
  }
})

afterEach(cleanup)

function setup(openSettingsId: string | null = null, refs?: ShotFlowNode['data']['refs']) {
  const api: NodeEditApi = {
    projectId: 'p-1',
    openSettingsId,
    toggleSettings: vi.fn(),
    closeSettings: vi.fn(),
    patchNode: vi.fn(),
    duplicateNode: vi.fn(),
    deleteNode: vi.fn(),
    shotCountOf: () => 0,
    beatFulfillmentOf: () => null,
    settings: { characters: [], locations: [] },
    assets: {
      byId: {
        'pa-1': {
          id: 'pa-1',
          relPath: 'assets/pa-1.png',
          mime: 'image/png',
          source: 'upload',
          createdAt: '2026-09-04T08:00:00.000Z',
        },
      },
    },
  }
  const props = {
    id: 'sh1',
    data: {
      shotNo: 3,
      size: '特写',
      picture: '档案袋里的旧照片特写。',
      prompt: 'extreme close-up, raindrops',
      refs: refs ?? [
        { id: 'r1', kind: 'character' as const, label: '林晚垫图' },
        { id: 'r2', kind: 'location' as const, label: '天台底图' },
        { id: 'r3', kind: 'audio' as const, label: '雨声' },
      ],
    },
    selected: false,
  } as unknown as NodeProps<ShotFlowNode>
  const { container } = render(
    <NodeEditContext.Provider value={api}>
      <ShotNode {...props} />
    </NodeEditContext.Provider>,
  )
  return { api, container }
}

describe('ShotNode（监视器卡）', () => {
  it('标题行：补零 SHOT 编号 + 景别；正文：画面描述与镜头 Prompt', () => {
    setup()
    expect(screen.getByText('SHOT 03')).toBeTruthy()
    expect(screen.getByText('特写')).toBeTruthy()
    expect(screen.getByText('档案袋里的旧照片特写。')).toBeTruthy()
    expect(screen.getByText('extreme close-up, raindrops')).toBeTruthy()
  })

  it('引用位 chip：三类引用各带图标，另含「＋ 引用」占位', () => {
    setup()
    expect(screen.getByText('👤 林晚垫图')).toBeTruthy()
    expect(screen.getByText('🏞 天台底图')).toBeTruthy()
    expect(screen.getByText('🎵 雨声')).toBeTruthy()
    expect(screen.getByText('＋ 引用')).toBeTruthy()
  })

  it('⚙️ 点击 toggleSettings；openSettingsId 命中时展开设置面板（含添加引用）', () => {
    const { api } = setup()
    fireEvent.click(screen.getByRole('button', { name: '分镜设置' }))
    expect(api.toggleSettings).toHaveBeenCalledWith('sh1')
    cleanup()

    setup('sh1')
    expect(screen.getByRole('button', { name: '＋ 添加引用' })).toBeTruthy()
  })

  it('端口：顶部入口（宿主下挂）+ 右侧出口', () => {
    setup()
    expect(screen.getByTestId('handle-target')).toBeTruthy()
    expect(screen.getByTestId('handle-source')).toBeTruthy()
  })

  it('资产引用位：image/* 资产经 mediaUrl 解析渲染缩略图；解析失败回退纯文本', async () => {
    const { projectAssets } = await import('../projectAssets')
    vi.mocked(projectAssets.mediaUrl).mockResolvedValue('asset://media/pa-1')
    const { container } = setup(null, [{ id: 'r4', kind: 'character', assetId: 'pa-1' }])
    const img = (await screen.findAllByRole('img'))[0]
    expect(img.getAttribute('src')).toBe('asset://media/pa-1')
    expect(vi.mocked(projectAssets.mediaUrl).mock.calls[0][0]).toBe('p-1')
    // chip 仍带 kind 图标与可辨认文本
    expect(container.textContent).toContain('👤')
    expect(container.textContent).toContain('pa-1')
  })
})
