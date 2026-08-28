// @vitest-environment happy-dom
/**
 * 编辑器左栏组件测试：大纲分段的集分组/行标签/节拍兑现徽标、
 * 行点击定位与集聚焦、集标题行内改名、大纲拖拽落点（行/组）、
 * 设定集分段的增删改与实体拖拽负载、资产分段挂载。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import LeftPanel, { type SettingsActions } from './LeftPanel'
import { PW_ENTITY_MIME, type EntityDragPayload } from '../dragDrop'
import type { CanvasNode } from '../nodes/types'

afterEach(cleanup)

beforeAll(() => {
  // happy-dom 未实现 scrollIntoView（反向联动 effect 用）
  Element.prototype.scrollIntoView = vi.fn()
})

const OUTLINE_MIME = 'application/x-pw-outline'

const nodes: CanvasNode[] = [
  {
    id: 's1',
    type: 'scene',
    position: { x: 100, y: 0 },
    data: {
      name: '场一', sceneNo: 1, interior: true, time: '🌙 夜',
      synopsis: '', characterIds: [], episodeNo: 1,
    },
  } as CanvasNode,
  {
    id: 'b1',
    type: 'beat',
    position: { x: 0, y: 0 },
    data: { name: '节拍一', tone: '紧张', episodeNo: 1 },
  } as CanvasNode,
  {
    id: 'd1',
    type: 'dialogue',
    position: { x: 200, y: 0 },
    data: { name: '对白一', lines: [] },
  } as CanvasNode,
]

function setup(over: Partial<Parameters<typeof LeftPanel>[0]> = {}) {
  const settingsActions: SettingsActions = {
    addCharacter: vi.fn(),
    renameCharacter: vi.fn(),
    deleteCharacter: vi.fn(),
    addLocation: vi.fn(),
    renameLocation: vi.fn(),
    deleteLocation: vi.fn(),
  }
  const spies = {
    onResize: vi.fn(),
    onLocate: vi.fn(),
    onFocusEpisode: vi.fn(),
    onRenameEpisode: vi.fn(),
    onOutlineDrop: vi.fn(),
    settingsActions,
  }
  render(
    <LeftPanel
      open
      width={280}
      nodes={nodes}
      edges={[]}
      settings={{
        characters: [{ id: 'c1', name: '林晚', gradient: 'g1' }],
        locations: [{ id: 'l1', name: '天台' }],
      }}
      episodeTitles={{ 1: '开局' }}
      focusedEpisode={null}
      {...spies}
      {...over}
    />,
  )
  return spies
}

/** 大纲行查询：行是 button，文本含 label。 */
const row = (label: string) =>
  screen.getAllByRole('button').find((b) => b.classList.contains('pw-outline-row') && b.textContent?.includes(label))!

/** dataTransfer 桩：happy-dom 的 DragEvent 不带数据通道。 */
function dt(init: Record<string, string> = {}) {
  const store = { ...init }
  return {
    store,
    getData: (k: string) => store[k as keyof typeof store] ?? '',
    setData: (k: string, v: string) => {
      store[k as keyof typeof store] = v as never
    },
    get types() {
      return Object.keys(store)
    },
    dropEffect: '',
    effectAllowed: '',
  }
}

describe('LeftPanel 大纲分段', () => {
  it('按集分组渲染：集行标题/计数、行标签格式、未分集组、节拍待兑现徽标', () => {
    setup()
    expect(screen.getByRole('button', { name: '第 1 集' })).toBeTruthy()
    expect(screen.getByText('开局')).toBeTruthy()
    expect(screen.getByText('2 行')).toBeTruthy()
    expect(row('场 01 · 场一')).toBeTruthy()
    expect(row('节拍 · 节拍一')).toBeTruthy()
    expect(screen.getByText('待兑现')).toBeTruthy() // 无 sequence 邻接场景
    expect(screen.getByText('未分集')).toBeTruthy()
    expect(row('对白 · 对白一')).toBeTruthy()
  })

  it('点击行定位画布节点；点击集行聚焦该集', () => {
    const spies = setup()
    fireEvent.click(row('场 01 · 场一'))
    expect(spies.onLocate).toHaveBeenCalledWith('s1')
    fireEvent.click(screen.getByRole('button', { name: '第 1 集' }))
    expect(spies.onFocusEpisode).toHaveBeenCalledWith(1)
  })

  it('集标题行内改名（编辑即命令）', () => {
    const spies = setup()
    fireEvent.doubleClick(screen.getByRole('button', { name: '开局' }))
    const input = screen.getByRole('textbox', { name: '第 1 集标题' })
    fireEvent.change(input, { target: { value: '新标题' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(spies.onRenameEpisode).toHaveBeenCalledWith(1, '新标题')
  })

  it('selectedId 反向高亮大纲行', () => {
    setup({ selectedId: 's1' })
    expect(row('场 01 · 场一').className).toContain('pw-outline-on')
    expect(row('节拍 · 节拍一').className).not.toContain('pw-outline-on')
  })
})

describe('LeftPanel 大纲拖拽', () => {
  it('行拖拽负载写 OUTLINE_MIME；落到行触发 row 落点（默认 after）', () => {
    const spies = setup()
    const d = dt()
    fireEvent.dragStart(row('节拍 · 节拍一'), { dataTransfer: d })
    expect(d.store[OUTLINE_MIME]).toBe('b1')

    fireEvent.drop(row('场 01 · 场一'), { dataTransfer: dt({ [OUTLINE_MIME]: 'b1' }) })
    expect(spies.onOutlineDrop).toHaveBeenCalledWith('b1', {
      kind: 'row',
      anchorId: 's1',
      position: 'after',
    })
  })

  it('拖到「未分集」组头触发 groupEnd 落点', () => {
    const spies = setup()
    fireEvent.drop(screen.getByText('未分集'), { dataTransfer: dt({ [OUTLINE_MIME]: 's1' }) })
    expect(spies.onOutlineDrop).toHaveBeenCalledWith('s1', { kind: 'groupEnd', episode: null })
  })

  it('拖拽源与目标相同则不派发', () => {
    const spies = setup()
    fireEvent.drop(row('场 01 · 场一'), { dataTransfer: dt({ [OUTLINE_MIME]: 's1' }) })
    expect(spies.onOutlineDrop).not.toHaveBeenCalled()
  })
})

describe('LeftPanel 设定集分段', () => {
  const toSettingsTab = () => {
    fireEvent.click(screen.getByRole('button', { name: '设定集' }))
  }

  it('新增/删除角色与地点透传动作', () => {
    const spies = setup()
    toSettingsTab()
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增角色' }))
    expect(spies.settingsActions.addCharacter).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '删除角色 林晚' }))
    expect(spies.settingsActions.deleteCharacter).toHaveBeenCalledWith('c1')
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增地点' }))
    expect(spies.settingsActions.addLocation).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '删除地点 天台' }))
    expect(spies.settingsActions.deleteLocation).toHaveBeenCalledWith('l1')
  })

  it('角色行内改名透传 renameCharacter', () => {
    const spies = setup()
    toSettingsTab()
    fireEvent.doubleClick(screen.getByRole('button', { name: '林晚' }))
    const input = screen.getByRole('textbox', { name: '角色名 林晚' })
    fireEvent.change(input, { target: { value: '林晚晴' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(spies.settingsActions.renameCharacter).toHaveBeenCalledWith('c1', '林晚晴')
  })

  it('实体拖拽负载为 PW_ENTITY_MIME JSON', () => {
    setup()
    toSettingsTab()
    const d = dt()
    fireEvent.dragStart(screen.getByTitle(/拖到画布节点建立引用/), { dataTransfer: d })
    const payload = JSON.parse(d.store[PW_ENTITY_MIME]) as EntityDragPayload
    expect(payload).toEqual({ kind: 'character', id: 'c1', name: '林晚' })
  })
})

describe('LeftPanel 外壳', () => {
  it('折叠时 aria-hidden 且无调宽手柄；切到资产分段挂载 AssetsPanel', async () => {
    const spies = setup({ open: false })
    const aside = document.querySelector('.pw-panel-left')!
    expect(aside.getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelector('.pw-panel-resizer')).toBeNull()
    void spies

    cleanup()
    setup()
    fireEvent.click(screen.getByRole('button', { name: '资产' }))
    expect(await screen.findByText('个人资产库 · 跨项目')).toBeTruthy()
  })
})
