// @vitest-environment happy-dom
/**
 * 场景节点（索引卡）渲染测试：SCENE 编号/内外景/地点时间天气 chip、
 * 分镜计数、角色头像串与失效兜底、设定集投影实时解析。
 * ⚙️ 面板开关与端口布局等外壳共享行为收敛至 nodeChrome.test.tsx
 * 参数化维护（issue #534）；Handle 桩与 NodeEditApi 夹具见
 * testScaffolding.tsx。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { NodeEditContext } from '../nodeEdit'
import type { ProjectSettings } from '../settings'
import { makeNodeEditApi } from './testScaffolding'
import { SceneNode } from './SceneNode'
import type { SceneFlowNode, SceneNodeData } from './types'
import type { PatchShape } from './patch'

vi.mock('@xyflow/react', async (importOriginal) =>
  (await import('./testScaffolding')).stubReactFlowHandleModule(
    await importOriginal<typeof import('@xyflow/react')>(),
  ),
)

afterEach(cleanup)

const SETTINGS: ProjectSettings = {
  characters: [
    { id: 'c1', name: '林晚', gradient: 'linear-gradient(#a700ab, #047ad2)' },
    { id: 'c2', name: '陈默', gradient: 'g2' },
  ],
  locations: [{ id: 'l1', name: '天台' }],
}

const DATA: SceneNodeData = {
  name: '天台对峙',
  sceneNo: 3,
  interior: false,
  locationId: 'l1',
  time: '🌙 夜',
  weather: '🌧 雨',
  synopsis: '陈默坦白当年真相。',
  characterIds: ['c1', 'gone'],
}

function setup(
  // 覆盖补丁走 PatchShape 清除通道（issue #231）：{ locationId: undefined }
  // = 清除地点引用，与产品补丁语义一致
  data: PatchShape<SceneNodeData> = {},
) {
  const api = makeNodeEditApi({
    shotCountOf: () => 2,
    settings: structuredClone(SETTINGS),
  })
  const props = {
    id: 's1',
    data: { ...DATA, ...data },
    selected: true,
  } as unknown as NodeProps<SceneFlowNode>
  const { container, unmount, rerender } = render(
    <ReactFlowProvider>
      <NodeEditContext.Provider value={api}>
        <SceneNode {...props} />
      </NodeEditContext.Provider>
    </ReactFlowProvider>,
  )
  /** 模拟设定集投影更新，保留当前节点的人物 id 引用。 */
  const rerenderSettings = (settings: ProjectSettings) =>
    rerender(
      <ReactFlowProvider>
        <NodeEditContext.Provider value={{ ...api, settings }}>
          <SceneNode {...props} />
        </NodeEditContext.Provider>
      </ReactFlowProvider>,
    )
  return { container, unmount, rerenderSettings }
}

describe('SceneNode（索引卡）', () => {
  it('标题栏：名称 + 补零 SCENE 编号 + 分镜计数（shotCountOf 派生）', () => {
    setup()
    expect(screen.getByText('天台对峙')).toBeTruthy()
    expect(screen.getByText('SCENE 03')).toBeTruthy()
    expect(screen.getByText('2 镜')).toBeTruthy()
  })

  it('meta 行：外景 chip、地点名解析、时间与可选天气', () => {
    setup()
    expect(screen.getByText('外')).toBeTruthy()
    expect(screen.getByText('天台')).toBeTruthy()
    expect(screen.getByText('夜')).toBeTruthy()
    expect(screen.getByText('雨')).toBeTruthy()
    for (const name of ['地点：天台', '时间：夜', '天气：雨']) {
      const tag = screen.getByRole('group', { name })
      expect(tag.querySelector('svg')?.getAttribute('stroke')).toBe(
        'currentColor',
      )
      expect(tag.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('地点引用失效仍有警告与失效样式，未指定地点使用常态标签', () => {
    const { container, unmount } = setup({ locationId: 'ghost' })
    const bad = container.querySelector('.pw-invalid')
    expect(bad?.textContent).toBe('未指定')
    expect(screen.getByTitle('地点引用已失效')).toBeTruthy()
    unmount()

    setup({ locationId: undefined })
    expect(screen.getByRole('group', { name: '地点：未指定' })).toBeTruthy()
  })

  it('角色头像串：命中渲染中性头像，失效 ✕；无角色不渲染头像区', () => {
    const { container, unmount } = setup()
    const avatars = container.querySelectorAll('.pw-avs .pw-av')
    expect(avatars).toHaveLength(2)
    expect(avatars[0].textContent).toBe('林')
    expect((avatars[0] as HTMLElement).style.background).toBe('')
    expect(avatars[1].textContent).toBe('✕')
    unmount()

    const bare = setup({ characterIds: [] })
    expect(bare.container.querySelector('.pw-avs')).toBeNull()
  })

  it('设定集人物改名、删除及恢复时，同一引用的头像随投影更新', () => {
    const { container, rerenderSettings } = setup()
    const renamed: ProjectSettings = {
      ...SETTINGS,
      characters: [{ ...SETTINGS.characters[0], name: '顾宁' }],
    }
    rerenderSettings(renamed)
    expect(container.querySelector('.pw-node-avatar')?.textContent).toBe('顾')
    rerenderSettings({ ...SETTINGS, characters: [] })
    expect(container.querySelectorAll('.pw-av-invalid')).toHaveLength(2)
    rerenderSettings(SETTINGS)
    expect(container.querySelector('.pw-node-avatar')?.textContent).toBe('林')
    expect(container.querySelectorAll('.pw-av-invalid')).toHaveLength(1)
  })
})
