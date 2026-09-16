// @vitest-environment happy-dom
/**
 * 位置帧渲染隔离 profile（issue #157，测量先行）：真实 Provider → 装配层
 * → 布局层全链渲染，仅替换 ReactFlow 为 props 捕获桩（经真实 onNodesChange
 * 驱动拖拽过程帧）、AiThread 为渲染计数探针；mock outline/graphDigest 包
 * 装实际实现计数派生调用。度量「无内容变化的位置帧」触发的无关派生与
 * AI 面板渲染；内容/选择/序变化仍须及时更新（反 stale 断言）。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from './EditorView'
import type { EditorProjectContent } from './useEditorDocument'
import type { CanvasNode } from './nodes/types'
import type { NodeChange } from '@xyflow/react'

/** ReactFlow props 捕获桩（经 vi.hoisted 供 mock 工厂引用）。 */
const flow = vi.hoisted(() => ({
  onNodesChange: null as null | ((changes: NodeChange[]) => void),
}))
/** 派生调用计数（包装实际实现计数，不改变行为）。 */
const counts = vi.hoisted(() => ({
  outline: 0,
  fulfillment: 0,
  digest: 0,
  aiPanel: 0,
}))

vi.mock('@xyflow/react', async (orig) => {
  const actual = await orig<typeof import('@xyflow/react')>()
  return {
    ...actual,
    ReactFlow: (props: { onNodesChange?: (c: NodeChange[]) => void }) => {
      flow.onNodesChange = props.onNodesChange ?? null
      return null
    },
  }
})

vi.mock('./outline', async (orig) => {
  const actual = await orig<typeof import('./outline')>()
  return {
    ...actual,
    buildOutlineGroups: (
      ...args: Parameters<typeof actual.buildOutlineGroups>
    ) => {
      counts.outline += 1
      return actual.buildOutlineGroups(...args)
    },
    beatFulfillmentMap: (
      ...args: Parameters<typeof actual.beatFulfillmentMap>
    ) => {
      counts.fulfillment += 1
      return actual.beatFulfillmentMap(...args)
    },
  }
})

vi.mock('./ai/graphDigest', async (orig) => {
  const actual = await orig<typeof import('./ai/graphDigest')>()
  return {
    ...actual,
    buildGraphDigest: (...args: Parameters<typeof actual.buildGraphDigest>) => {
      counts.digest += 1
      return actual.buildGraphDigest(...args)
    },
  }
})

// 探针挂真实 AiThread 必然渲染的子组件（AiTopbar）且**不带自有 memo**
// （PR #194 评审 4027847221）：计数的是真实 AiThread 渲染体的执行——
// 生产 memo 边界被移除时，位置帧会逐帧驱动子探针、测试失败；mock 若
// 自带 memo 会替换掉真实组件，永远测不到生产边界。
vi.mock('./panels/AiThreadTopbar', async (orig) => {
  const actual = await orig<typeof import('./panels/AiThreadTopbar')>()
  return {
    ...actual,
    AiTopbar: function AiTopbarRenderProbe() {
      counts.aiPanel += 1
      return null
    },
  }
})

afterEach(cleanup)

const node = (
  id: string,
  type: CanvasNode['type'],
  x: number,
  data: Record<string, unknown>,
): CanvasNode =>
  ({ id, type, position: { x, y: 0 }, data }) as unknown as CanvasNode

/** 代表性图：六类节点 + 剧情/分支/下挂边（issue 草案：代表性图）。 */
const PROJECT: EditorProjectContent = {
  id: 'p-157',
  name: '位置帧隔离',
  nodes: [
    node('bt1', 'beat', 0, { name: '开端', tone: '紧张', episodeNo: 1 }),
    node('sc1', 'scene', 300, {
      name: '茶馆',
      sceneNo: 1,
      interior: true,
      time: '夜',
      synopsis: '',
      characterIds: [],
      episodeNo: 1,
    }),
    node('dl1', 'dialogue', 600, { name: '对质', lines: [], episodeNo: 1 }),
    node('br1', 'branch', 900, {
      prompt: '追吗？',
      options: [
        { id: 'o-a', label: '追' },
        { id: 'o-b', label: '不追' },
      ],
      episodeNo: 1,
    }),
    node('sh1', 'shot', 300, {
      shotNo: 1,
      size: '特写',
      picture: '',
      prompt: '',
      refs: [],
    }),
    node('im1', 'image', 1200, { prompt: '霓虹', size: '1024x1024' }),
  ],
  edges: [
    { id: 'e1', source: 'bt1', target: 'sc1' },
    { id: 'e2', source: 'sc1', target: 'dl1' },
    { id: 'e3', source: 'dl1', target: 'br1' },
    {
      id: 'e4',
      source: 'sc1',
      target: 'sh1',
      sourceHandle: 'shots',
    },
    { id: 'e5', source: 'br1', target: 'sc1', sourceHandle: 'option-o-a' },
  ],
  settings: { characters: [], locations: [] },
}

function mount() {
  render(
    <EditorView
      project={PROJECT}
      onBackHome={vi.fn()}
      onRenameProject={vi.fn()}
      onSave={vi.fn()}
    />,
  )
}

/** 拖拽过程帧：经真实 onNodesChange 通道驱动 position 变更。 */
const dragFrame = (id: string, x: number) =>
  act(() => {
    flow.onNodesChange?.([
      { id, type: 'position', position: { x, y: 0 }, dragging: true },
    ])
  })

const selectFrame = (id: string) =>
  act(() => {
    flow.onNodesChange?.([{ id, type: 'select', selected: true }])
  })

describe('位置帧渲染隔离 profile（issue #157）', () => {
  beforeEach(() => {
    counts.outline = 0
    counts.fulfillment = 0
    counts.digest = 0
    counts.aiPanel = 0
  })

  it('无内容变化的拖拽过程帧：不重算大纲/兑现/摘要，不重渲染 AI 面板', () => {
    mount()
    expect(counts.outline).toBeGreaterThan(0) // 挂载基线已建立
    const base = { ...counts }

    // 5 帧同向小幅位移（不跨越其他节点 x 序）
    for (let i = 1; i <= 5; i++) dragFrame('bt1', 10 * i)
    expect(counts.outline).toBe(base.outline)
    expect(counts.fulfillment).toBe(base.fulfillment)
    expect(counts.digest).toBe(base.digest)
    expect(counts.aiPanel).toBe(base.aiPanel)

    // 选择帧（会话态）：同样不触发内容派生与 AI 面板
    selectFrame('sc1')
    expect(counts.outline).toBe(base.outline)
    expect(counts.digest).toBe(base.digest)
    expect(counts.aiPanel).toBe(base.aiPanel)
  })

  it('内容变化仍及时更新全部派生与 AI 面板（反 stale）', () => {
    mount()
    const base = { ...counts }
    // 真实内容新增：＋菜单创建场景（EditorView.test 同款入口）
    fireEvent.click(screen.getByLabelText('新增节点'))
    fireEvent.click(screen.getByRole('menuitem', { name: '场景' }))
    expect(counts.outline).toBeGreaterThan(base.outline)
    expect(counts.fulfillment).toBeGreaterThan(base.fulfillment)
    expect(counts.digest).toBeGreaterThan(base.digest)
    expect(counts.aiPanel).toBeGreaterThan(base.aiPanel)
  })

  it('x 序变化的位移仍重算大纲（大纲行序依赖位置，反 stale）', () => {
    mount()
    const base = { ...counts }
    // bt1 从 x=0 拖到 x=1500（跨越全部节点，改变组内 x 序）
    dragFrame('bt1', 1500)
    expect(counts.outline).toBeGreaterThan(base.outline)
    // 摘要与兑现仍是纯内容派生：序变化不触发
    expect(counts.digest).toBe(base.digest)
  })
})
