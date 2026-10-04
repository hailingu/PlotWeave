// @vitest-environment happy-dom
/**
 * 分镜卡（监视器卡）渲染测试：SHOT 编号/景别标题行、画面描述、
 * 镜头 Prompt、引用位 chip（角色垫图/场景底图/音频图标）、⚙️ 面板开关。
 * Handle 依赖 React Flow 仓库上下文，隔离渲染时以锚点桩替代。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { NodeProps } from '@xyflow/react'
import { NodeEditContext, type NodeEditApi } from '../nodeEdit'
import { projectAssets } from '../projectAssets'
import type { AssetRef } from '../../model/document'
import { ShotNode } from './ShotNode'
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
      <div
        data-testid={`handle-${props.type}${props.id ? `-${props.id}` : ''}`}
      />
    ),
  }
})

afterEach(cleanup)

function setup(
  openSettingsId: string | null = null,
  refs?: ShotFlowNode['data']['refs'],
) {
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
    const { container } = setup(null, [
      { id: 'r4', kind: 'character', assetId: 'pa-1' },
    ])
    const img = (await screen.findAllByRole('img'))[0]
    expect(img.getAttribute('src')).toBe('asset://media/pa-1')
    expect(vi.mocked(projectAssets.mediaUrl).mock.calls[0][0]).toBe('p-1')
    // chip 仍带 kind 图标与可辨认文本
    expect(container.textContent).toContain('👤')
    expect(container.textContent).toContain('pa-1')
  })
})

/** issue #131 用例的资产条目助手。 */
const refAsset = (id: string): AssetRef => ({
  id,
  relPath: `assets/${id}.png`,
  mime: 'image/png',
  source: 'upload',
  createdAt: '2026-09-04T08:00:00.000Z',
})

/** 可重渲染的隔离渲染（issue #131：换绑 = 同一 RefThumb 实例换 assetId）。
 * byId 可传新对象模拟无关编辑导致的索引重建（同 id 新身份）。 */
function renderShotWithRef(
  assetId: string,
  byId: Record<string, AssetRef> = { 'pa-1': refAsset('pa-1') },
  kind: ShotFlowNode['data']['refs'][number]['kind'] = 'character',
) {
  const api: NodeEditApi = {
    projectId: 'p-1',
    openSettingsId: null,
    toggleSettings: vi.fn(),
    closeSettings: vi.fn(),
    patchNode: vi.fn(),
    duplicateNode: vi.fn(),
    deleteNode: vi.fn(),
    shotCountOf: () => 0,
    beatFulfillmentOf: () => null,
    settings: { characters: [], locations: [] },
    assets: { byId },
  }
  const props = (id: string) =>
    ({
      id: 'sh1',
      data: {
        shotNo: 3,
        size: '特写',
        picture: '画面',
        prompt: 'prompt',
        refs: [{ id: 'r4', kind, assetId: id }],
      },
      selected: false,
    }) as unknown as NodeProps<ShotFlowNode>
  const view = render(
    <NodeEditContext.Provider value={api}>
      <ShotNode {...props(assetId)} />
    </NodeEditContext.Provider>,
  )
  return {
    rerender: (id: string, nextById?: Record<string, AssetRef>) => {
      if (nextById !== undefined) api.assets = { byId: nextById }
      view.rerender(
        <NodeEditContext.Provider value={api}>
          <ShotNode {...props(id)} />
        </NodeEditContext.Provider>,
      )
    },
  }
}

describe('分镜引用资产读取边界（issue #130）', () => {
  beforeEach(() => {
    vi.mocked(projectAssets.mediaUrl)
      .mockReset()
      .mockResolvedValue('asset://valid')
  })

  // 去掉自有属性检查会把原型成员当资产；普通缺失也必须留下可定位占位。
  it.each(['constructor', 'toString', '__proto__', 'missing'])(
    '非自有资产 %s 保留引用并显示局部缺失警告',
    (assetId) => {
      renderShotWithRef(assetId, {})
      expect(screen.getByTitle(`引用资产缺失（${assetId}）`)).toBeTruthy()
      expect(screen.getByText(`👤 ${assetId}`, { exact: false })).toBeTruthy()
      expect(screen.getByText('SHOT 03')).toBeTruthy()
      expect(screen.queryByRole('img')).toBeNull()
    },
  )

  // 绕过加载校验构造脏会话条目；缺少 MIME 类型防护会在 startsWith 抛错。
  it.each([null, { mime: undefined }, { mime: null }, { mime: 7 }])(
    '异型资产 %j 回退带资产 ID 的不可用警告',
    (malformed) => {
      const asset = (malformed && {
        ...refAsset('bad'),
        ...malformed,
      }) as unknown as AssetRef
      renderShotWithRef('bad', { bad: asset })
      expect(screen.getByTitle('引用资产不可用（bad）')).toBeTruthy()
      expect(screen.getByText('SHOT 03')).toBeTruthy()
      expect(screen.queryByRole('img')).toBeNull()
    },
  )

  it.each(['constructor', 'toString', '__proto__'])(
    '特殊键 %s 是自有合法图片时仍显示缩略图',
    async (assetId) => {
      renderShotWithRef(assetId, { [assetId]: refAsset(assetId) })
      const img = await screen.findByRole('img')
      expect(img.getAttribute('src')).toBe('asset://valid')
      expect(img.getAttribute('alt')).toBe(`assets/${assetId}.png`)
      expect(screen.queryByTitle(/引用资产/)).toBeNull()
    },
  )

  it('合法音频引用保留图标与 ID，无图片或错误占位', () => {
    renderShotWithRef(
      'audio',
      { audio: { ...refAsset('audio'), mime: 'audio/mpeg' } },
      'audio',
    )
    expect(screen.getByText('🎵 audio')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByTitle(/引用资产/)).toBeNull()
  })
})

describe('分镜坏引用的隔离与恢复（issue #130）', () => {
  beforeEach(() => {
    vi.mocked(projectAssets.mediaUrl)
      .mockReset()
      .mockResolvedValue('asset://valid')
  })

  it('坏引用不会阻断同卡片的合法图片引用', async () => {
    setup(null, [
      { id: 'bad', kind: 'character', assetId: 'constructor' },
      { id: 'good', kind: 'location', assetId: 'pa-1' },
    ])
    expect(screen.getByTitle('引用资产缺失（constructor）')).toBeTruthy()
    expect((await screen.findByRole('img')).getAttribute('src')).toBe(
      'asset://valid',
    )
  })

  it.each([
    { byId: {}, title: '引用资产缺失（pa-1）' },
    {
      byId: { 'pa-1': { ...refAsset('pa-1'), mime: null } },
      title: '引用资产不可用（pa-1）',
    },
  ])('资产失效并恢复：$title 清旧图且保留引用', async ({ byId, title }) => {
    const { rerender } = renderShotWithRef('pa-1')
    await screen.findByRole('img')
    // JSON/会话脏数据绕过类型边界，渲染必须局部降级。
    rerender('pa-1', byId as unknown as Record<string, AssetRef>)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByTitle(title)).toBeTruthy()
    expect(screen.getByText(/👤 pa-1/)).toBeTruthy()

    rerender('pa-1', { 'pa-1': refAsset('pa-1') })
    expect((await screen.findByRole('img')).getAttribute('src')).toBe(
      'asset://valid',
    )
    expect(screen.queryByTitle(/引用资产/)).toBeNull()
  })
})

describe('RefThumb 引用位缩略图生命周期（issue #131）', () => {
  beforeEach(() => {
    vi.mocked(projectAssets.mediaUrl).mockReset()
  })

  it('改绑不可读资产：旧缩略图清除，失败 ⚠ 可定位，不以旧图冒充新引用', async () => {
    vi.mocked(projectAssets.mediaUrl)
      .mockResolvedValueOnce('asset://a')
      .mockRejectedValueOnce(new Error('媒体不可读'))
    const byId = { 'pa-1': refAsset('pa-1'), 'pa-2': refAsset('pa-2') }
    const { rerender } = renderShotWithRef('pa-1', byId)
    expect((await screen.findByRole('img')).getAttribute('src')).toBe(
      'asset://a',
    )
    rerender('pa-2')
    expect(
      await screen.findByTitle('媒体不可读（assets/pa-2.png）'),
    ).toBeTruthy()
    // A 的 url 不得残留冒充 B（issue #131 核心缺陷）
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('换绑过渡窗口：新解析在途时清空旧图，不得以 A 占位等待 B', async () => {
    let resolveB: (u: string) => void = () => {}
    vi.mocked(projectAssets.mediaUrl)
      .mockResolvedValueOnce('asset://a')
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveB = r
          }),
      )
    const byId = { 'pa-1': refAsset('pa-1'), 'pa-2': refAsset('pa-2') }
    const { rerender } = renderShotWithRef('pa-1', byId)
    expect((await screen.findByRole('img')).getAttribute('src')).toBe(
      'asset://a',
    )
    rerender('pa-2')
    // 过渡窗口无图（旧实现残留 asset://a 冒充 B）
    expect(screen.queryByRole('img')).toBeNull()
    resolveB('asset://b')
    expect((await screen.findByRole('img')).getAttribute('src')).toBe(
      'asset://b',
    )
  })

  it('换绑乱序：迟到的旧解析不得覆盖新引用', async () => {
    let resolveA: (u: string) => void = () => {}
    vi.mocked(projectAssets.mediaUrl)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveA = r
          }),
      )
      .mockResolvedValueOnce('asset://b')
    const byId = { 'pa-1': refAsset('pa-1'), 'pa-2': refAsset('pa-2') }
    const { rerender } = renderShotWithRef('pa-1', byId)
    rerender('pa-2')
    expect((await screen.findByRole('img')).getAttribute('src')).toBe(
      'asset://b',
    )
    resolveA('asset://a-late')
    await Promise.resolve()
    expect(screen.getByRole('img').getAttribute('src')).toBe('asset://b')
  })

  it('URL 解析成功但图像加载失败：onError 转 ⚠ 失败标记，无半图残留', async () => {
    vi.mocked(projectAssets.mediaUrl).mockResolvedValueOnce('asset://broken')
    renderShotWithRef('pa-1')
    const img = await screen.findByRole('img')
    img.dispatchEvent(new window.Event('error'))
    expect(
      await screen.findByTitle('媒体不可读（assets/pa-1.png）'),
    ).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('读取失败后重挂载（应用重载）且媒体恢复：正常显示', async () => {
    vi.mocked(projectAssets.mediaUrl)
      .mockRejectedValueOnce(new Error('媒体不可读'))
      .mockResolvedValue('asset://fresh')
    renderShotWithRef('pa-1')
    expect(await screen.findByTitle(/媒体不可读/)).toBeTruthy()
    cleanup()
    renderShotWithRef('pa-1')
    expect((await screen.findByRole('img')).getAttribute('src')).toBe(
      'asset://fresh',
    )
  })

  it('同 id 的资产对象身份变化（无关编辑致索引重建）不重取缩略图', async () => {
    vi.mocked(projectAssets.mediaUrl).mockResolvedValue('asset://a')
    const { rerender } = renderShotWithRef('pa-1')
    await screen.findByRole('img')
    rerender('pa-1', { 'pa-1': refAsset('pa-1') })
    expect(vi.mocked(projectAssets.mediaUrl)).toHaveBeenCalledTimes(1)
  })
})
