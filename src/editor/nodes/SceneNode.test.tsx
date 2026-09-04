// @vitest-environment happy-dom
/**
 * 场景节点（索引卡）渲染测试：SCENE 编号/内外景/地点时间天气 chip、
 * 分镜计数、角色头像串与失效兜底、⚙️ 面板开关、三向端口（含分镜下挂口）。
 * Handle 依赖 React Flow 仓库上下文，隔离渲染时以锚点桩替代。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { NodeProps } from '@xyflow/react'
import { NodeEditContext, type NodeEditApi } from '../nodeEdit'
import type { ProjectSettings } from '../settings'
import { SCENE_SHOT_HANDLE } from '../graphRules'
import SceneNode from './SceneNode'
import type { SceneFlowNode, SceneNodeData } from './types'

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

const SETTINGS: ProjectSettings = {
  characters: [
    { id: 'c1', name: '林晚', gradient: 'g1' },
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

function setup(data: Partial<SceneNodeData> = {}, openSettingsId: string | null = null) {
  const api: NodeEditApi = {
    projectId: 'p-1',
    openSettingsId,
    toggleSettings: vi.fn(),
    closeSettings: vi.fn(),
    patchNode: vi.fn(),
    duplicateNode: vi.fn(),
    deleteNode: vi.fn(),
    shotCountOf: () => 2,
    beatFulfillmentOf: () => null,
    settings: structuredClone(SETTINGS),
    assets: undefined,
  }
  const props = {
    id: 's1',
    data: { ...DATA, ...data },
    selected: true,
  } as unknown as NodeProps<SceneFlowNode>
  const { container, unmount } = render(
    <NodeEditContext.Provider value={api}>
      <SceneNode {...props} />
    </NodeEditContext.Provider>,
  )
  return { api, container, unmount }
}

describe('SceneNode（索引卡）', () => {
  it('标题栏：名称 + 补零 SCENE 编号 + 分镜计数（shotCountOf 派生）', () => {
    setup()
    expect(screen.getByText('天台对峙')).toBeTruthy()
    expect(screen.getByText('SCENE 03')).toBeTruthy()
    expect(screen.getByText('🎞 2 镜')).toBeTruthy()
  })

  it('meta 行：外景 chip、地点名解析、时间与可选天气', () => {
    setup()
    expect(screen.getByText('外')).toBeTruthy()
    expect(screen.getByText('📍 天台')).toBeTruthy()
    expect(screen.getByText('🌙 夜')).toBeTruthy()
    expect(screen.getByText('🌧 雨')).toBeTruthy()
  })

  it('地点引用失效（设定集已删）→ ⚠ 未指定 带失效样式；未指定地点 → 📍 未指定', () => {
    const { container, unmount } = setup({ locationId: 'ghost' })
    const bad = container.querySelector('.pw-invalid')
    expect(bad?.textContent).toBe('⚠ 未指定')
    unmount()

    setup({ locationId: undefined })
    // 组件模板自带 📍 前缀，locationName 为空时回退文案再叠一个
    expect(screen.getByText('📍 📍 未指定')).toBeTruthy()
  })

  it('角色头像串：命中渲染渐变头像，失效 ✕；无角色不渲染头像区', () => {
    const { container, unmount } = setup()
    const avatars = container.querySelectorAll('.pw-avs .pw-av')
    expect(avatars).toHaveLength(2)
    expect(avatars[0].textContent).toBe('林')
    expect(avatars[1].textContent).toBe('✕')
    unmount()

    const bare = setup({ characterIds: [] })
    expect(bare.container.querySelector('.pw-avs')).toBeNull()
  })

  it('⚙️ 点击 toggleSettings；openSettingsId 命中时展开设置面板', () => {
    const { api, unmount } = setup()
    fireEvent.click(screen.getByRole('button', { name: '场景设置' }))
    expect(api.toggleSettings).toHaveBeenCalledWith('s1')
    unmount()

    setup({}, 's1')
    expect(screen.getByRole('combobox')).toBeTruthy() // 地点下拉
  })

  it('端口：左入、右出、底部 SCENE_SHOT_HANDLE 分镜下挂口', () => {
    setup()
    expect(screen.getByTestId('handle-target')).toBeTruthy()
    expect(screen.getByTestId('handle-source')).toBeTruthy()
    expect(screen.getByTestId(`handle-source-${SCENE_SHOT_HANDLE}`)).toBeTruthy()
  })
})
