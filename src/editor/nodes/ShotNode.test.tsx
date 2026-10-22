// @vitest-environment happy-dom
/**
 * 分镜卡（监视器卡）渲染测试：SHOT 编号/景别标题行、画面描述、
 * 镜头 Prompt、引用位 chip（角色垫图/场景底图/音频图标）、资产引用
 * 读取边界（issue #130）与缩略图失败占位接线（issue #131）。
 * ⚙️ 面板开关与端口布局等外壳共享行为收敛至 nodeChrome.test.tsx
 * 参数化维护（issue #534）；Handle 桩与 NodeEditApi 夹具见
 * testScaffolding.tsx。换绑在途清空/乱序隔离/重挂载恢复自 issue #541
 * 起仅在 useAssetMedia.test.tsx 断言；此处保留改绑失败接线集成用例
 * 与 onError 解码接线的 DOM 级断言（PR #561 评审 5512852009）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { NodeEditContext } from '../nodeEdit'
import { projectAssets } from '../projectAssets'
import type { AssetRef } from '../../model/document'
import { makeNodeEditApi } from './testScaffolding'
import { ShotNode } from './ShotNode'
import type { ShotFlowNode } from './types'

vi.mock('../projectAssets', () => ({
  projectAssets: {
    importFromLibrary: vi.fn(),
    mediaUrl: vi.fn(),
  },
}))

vi.mock('@xyflow/react', async (importOriginal) =>
  (await import('./testScaffolding')).stubReactFlowHandleModule(
    await importOriginal<typeof import('@xyflow/react')>(),
  ),
)

afterEach(cleanup)

function setup(refs?: ShotFlowNode['data']['refs']) {
  const api = makeNodeEditApi({
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
  })
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
    <ReactFlowProvider>
      <NodeEditContext.Provider value={api}>
        <ShotNode {...props} />
      </NodeEditContext.Provider>
    </ReactFlowProvider>,
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
    for (const name of [
      '角色垫图：林晚垫图',
      '场景底图：天台底图',
      '音频：雨声',
    ]) {
      const tag = screen.getByRole('group', { name })
      expect(tag.querySelector('svg')?.getAttribute('stroke')).toBe(
        'currentColor',
      )
      expect(tag.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    }
    expect(screen.getByText('＋ 引用')).toBeTruthy()
  })

  it('资产引用位：image/* 资产经 mediaUrl 解析渲染缩略图；解析失败回退纯文本', async () => {
    const { projectAssets } = await import('../projectAssets')
    vi.mocked(projectAssets.mediaUrl).mockResolvedValue('asset://media/pa-1')
    const { container } = setup([
      { id: 'r4', kind: 'character', assetId: 'pa-1' },
    ])
    const img = (await screen.findAllByRole('img'))[0]
    expect(img.getAttribute('src')).toBe('asset://media/pa-1')
    expect(vi.mocked(projectAssets.mediaUrl).mock.calls[0][0]).toBe('p-1')
    // chip 仍带 kind 图标与可辨认文本
    expect(screen.getByRole('group', { name: '角色垫图：pa-1' })).toBeTruthy()
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
  const api = makeNodeEditApi({ assets: { byId } })
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
    <ReactFlowProvider>
      <NodeEditContext.Provider value={api}>
        <ShotNode {...props(assetId)} />
      </NodeEditContext.Provider>
    </ReactFlowProvider>,
  )
  return {
    rerender: (id: string, nextById?: Record<string, AssetRef>) => {
      if (nextById !== undefined) api.assets = { byId: nextById }
      view.rerender(
        <ReactFlowProvider>
          <NodeEditContext.Provider value={api}>
            <ShotNode {...props(id)} />
          </NodeEditContext.Provider>
        </ReactFlowProvider>,
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
      expect(screen.getByText(assetId)).toBeTruthy()
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
    expect(screen.getByRole('group', { name: '音频：audio' })).toBeTruthy()
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
    setup([
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
    expect(screen.getByRole('group', { name: '角色垫图：pa-1' })).toBeTruthy()

    rerender('pa-1', { 'pa-1': refAsset('pa-1') })
    expect((await screen.findByRole('img')).getAttribute('src')).toBe(
      'asset://valid',
    )
    expect(screen.queryByTitle(/引用资产/)).toBeNull()
  })
})

describe('RefThumb 引用位缩略图接线（issue #131）', () => {
  beforeEach(() => {
    vi.mocked(projectAssets.mediaUrl).mockReset()
  })

  // 媒体生命周期接线（issue #541）：三条生命周期规则在
  // useAssetMedia.test.tsx 断言，此处以改绑失败集成用例证明换绑后 ⚠
  // 占位可观察且旧图不冒充新引用（缺陷溯源 issue #131：旧实现残留 A
  // 的 url 冒充 B）；onError 是组件自有的 DOM 事件接线，不随生命周期
  // 收敛，保留组件级断言（PR #561 评审 5512852009）。
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
})
