// @vitest-environment happy-dom
/**
 * 节点设置面板（=节点编辑器）组件测试：五类表单的分发与
 * 「编辑即命令」patch 形状、台词/选项/引用位的增删改、
 * 集归属归一化、复制/删除动作，以及 EditableName 的改名交互。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NodeEditContext, type NodeEditApi } from '../../nodeEdit'
import type { ProjectSettings } from '../../settings'
import NodeSettingsPanel, { EditableName, type PanelNode } from './NodeSettingsPanel'

afterEach(cleanup)

const SETTINGS: ProjectSettings = {
  characters: [
    { id: 'c1', name: '林晚', gradient: 'g1' },
    { id: 'c2', name: '苏珩', gradient: 'g2' },
  ],
  locations: [{ id: 'l1', name: '天台' }],
}

function setup(node: PanelNode) {
  const api: NodeEditApi = {
    openSettingsId: null,
    toggleSettings: vi.fn(),
    closeSettings: vi.fn(),
    patchNode: vi.fn(),
    duplicateNode: vi.fn(),
    deleteNode: vi.fn(),
    shotCountOf: () => 0,
    beatFulfillmentOf: () => null,
    settings: structuredClone(SETTINGS),
  }
  const { container } = render(
    <NodeEditContext.Provider value={api}>
      <NodeSettingsPanel node={node} />
    </NodeEditContext.Provider>,
  )
  return { api, container }
}

/** 取 patchNode 的第 n 次调用补丁。 */
const patchOf = (api: NodeEditApi, n = 0) =>
  (api.patchNode as ReturnType<typeof vi.fn>).mock.calls[n][1] as Record<string, unknown>

const sceneNode: PanelNode = {
  id: 'n1',
  type: 'scene',
  data: {
    name: '场一',
    sceneNo: 1,
    interior: true,
    time: '🌙 夜',
    synopsis: '',
    characterIds: ['c1'],
    locationId: 'l1',
  },
}

describe('SceneForm', () => {
  it('名称/梗概实时 patch；地点下拉可清空为未指定', () => {
    const { api } = setup(sceneNode)
    fireEvent.change(screen.getByDisplayValue('场一'), { target: { value: '场一改' } })
    expect(patchOf(api)).toEqual({ name: '场一改' })

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    expect(patchOf(api, 1)).toEqual({ locationId: undefined })
  })

  it('场次可改：正整数入 patch；清空不产生非法值（§4.3 场次编辑）', () => {
    const { api } = setup(sceneNode)
    const noInput = screen.getByDisplayValue('1')
    expect((noInput as HTMLInputElement).type).toBe('number')
    fireEvent.change(noInput, { target: { value: '5' } })
    expect(patchOf(api)).toEqual({ sceneNo: 5 })
    // 小数向下取整
    fireEvent.change(noInput, { target: { value: '7.9' } })
    expect(patchOf(api, 1)).toEqual({ sceneNo: 7 })
    // 清空：场景号必填，非法输入不产生 patch
    fireEvent.change(noInput, { target: { value: '' } })
    expect(api.patchNode).toHaveBeenCalledTimes(2)
  })

  it('场次/集归属拒绝非安全整数（§4.1 正安全整数域：有限但越界如 1e20 落载后会被顺位重发，输入边界同域拒收、保留原值）', () => {
    const { api } = setup(sceneNode)
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '100000000000000000000' } })
    fireEvent.change(screen.getByPlaceholderText('未分集'), { target: { value: '100000000000000000000' } })
    expect(api.patchNode).not.toHaveBeenCalled()
  })

  it('内外景分段与角色 chip 切换（引用设定集 id 增删）', () => {
    const { api, container } = setup(sceneNode)
    // happy-dom 会把 label 内点击同步激活其首个可标记控件（多派发一次 内），
    // 断言目标补丁出现过即可，不依赖调用次序
    const segButtons = container.querySelectorAll('.pw-set-seg button')
    fireEvent.click(segButtons[1])
    expect(api.patchNode).toHaveBeenCalledWith('n1', { interior: false })

    // happy-dom 中 label 包裹的 chip 可访问名串扰，用结构选择器：chips[1] = 苏珩
    const chips = container.querySelectorAll('.pw-set-chip')
    fireEvent.click(chips[1])
    expect(api.patchNode).toHaveBeenCalledWith('n1', { characterIds: ['c1', 'c2'] })
    fireEvent.click(chips[0])
    expect(api.patchNode).toHaveBeenCalledWith('n1', { characterIds: [] })
  })

  it('集归属：输入归一为正整数；清空/✕ 移出集传 undefined', () => {
    const { api } = setup(sceneNode)
    const epInput = screen.getByPlaceholderText('未分集')
    fireEvent.change(epInput, { target: { value: '3.9' } })
    expect(patchOf(api)).toEqual({ episodeNo: 3 })
    // happy-dom 的 number 输入不接受空串清空，undefined 路径由「移出集」按钮用例覆盖
    fireEvent.change(epInput, { target: { value: '0' } })
    expect(patchOf(api, 1)).toEqual({ episodeNo: 1 })
  })

  it('已分集时显示「移出集」按钮', () => {
    const { api } = setup({
      ...sceneNode,
      data: { ...sceneNode.data, episodeNo: 2 } as PanelNode['data'],
    } as PanelNode)
    fireEvent.click(screen.getByRole('button', { name: '移出集' }))
    expect(patchOf(api)).toEqual({ episodeNo: undefined })
  })

  it('设定集无角色时显示引导文案', () => {
    const { api } = setup(sceneNode)
    api.settings.characters.length = 0 // api 持有的是 clone，不污染共享夹具
    cleanup()
    render(
      <NodeEditContext.Provider value={api}>
        <NodeSettingsPanel node={sceneNode} />
      </NodeEditContext.Provider>,
    )
    expect(screen.getByText('设定集暂无角色，请在左栏新增')).toBeTruthy()
  })
})

describe('DialogueForm', () => {
  const dialogueNode: PanelNode = {
    id: 'd1',
    type: 'dialogue',
    data: {
      name: '对白',
      lines: [
        { id: 'line-t1', kind: 'line', speaker: 'c1', side: 'left', text: '第一句' },
        { id: 'line-t2', kind: 'action', text: '他转身' },
      ],
    },
  }

  it('添加台词默认挂设定集首个角色；删除指定行', () => {
    const { api } = setup(dialogueNode)
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加台词' }))
    const lines = patchOf(api).lines as Array<Record<string, unknown>>
    expect(lines).toHaveLength(3)
    expect(lines[2]).toMatchObject({ kind: 'line', speaker: 'c1', side: 'left', text: '' })
    expect(lines[2].id).toMatch(/^line-/)

    const delButtons = screen.getAllByRole('button', { name: '删除此行' })
    fireEvent.click(delButtons[0])
    const rest = patchOf(api, 1).lines as Array<{ text: string }>
    expect(rest.map((l) => l.text)).toEqual(['他转身'])
  })

  it('行类型切动作时清掉说话人与侧位；切回台词补默认说话人', () => {
    const { api } = setup(dialogueNode)
    const kindSelects = screen.getAllByRole('combobox', { name: '行类型' })
    fireEvent.change(kindSelects[0], { target: { value: 'action' } })
    const lines = patchOf(api).lines as Array<Record<string, unknown>>
    expect(lines[0]).toMatchObject({ id: 'line-t1', kind: 'action', text: '第一句' })
    expect(lines[0].speaker).toBeUndefined()
    expect(lines[0].side).toBeUndefined()

    fireEvent.change(kindSelects[1], { target: { value: 'line' } })
    const back = patchOf(api, 1).lines as Array<Record<string, unknown>>
    expect(back[1]).toMatchObject({ kind: 'line', speaker: 'c1', side: 'left' })
  })

  it('台词文本逐行 patch；说话人可经下拉改派', () => {
    const { api } = setup(dialogueNode)
    fireEvent.change(screen.getByDisplayValue('第一句'), { target: { value: '改后' } })
    const lines = patchOf(api).lines as Array<{ text: string }>
    expect(lines[0].text).toBe('改后')

    fireEvent.change(screen.getByRole('combobox', { name: '说话人' }), {
      target: { value: 'c2' },
    })
    const revoiced = patchOf(api, 1).lines as Array<{ speaker?: string }>
    expect(revoiced[0].speaker).toBe('c2')
  })
})

describe('BranchForm', () => {
  const branchNode: PanelNode = {
    id: 'b1',
    type: 'branch',
    data: {
      prompt: '她该怎么办？',
      options: [{ id: 'oa', label: ' A ' }, { id: 'ob', label: 'B' }],
    },
  }

  it('选项编辑（保 id）/添加（自动编号字母 + 新 id）/删除', () => {
    const { api } = setup(branchNode)
    fireEvent.change(screen.getByDisplayValue('B'), { target: { value: '离开' } })
    expect(patchOf(api).options).toEqual([{ id: 'oa', label: ' A ' }, { id: 'ob', label: '离开' }])

    fireEvent.click(screen.getByRole('button', { name: '＋ 添加选项' }))
    const grown = patchOf(api, 1).options as Array<{ id: string; label: string }>
    expect(grown).toHaveLength(3)
    expect(grown[2].label).toBe('选项 C')
    expect(grown[2].id).toMatch(/^opt-/)

    fireEvent.click(screen.getAllByRole('button', { name: '删除此选项' })[0])
    expect(patchOf(api, 2).options).toEqual([{ id: 'ob', label: 'B' }])
  })
})

describe('ShotForm', () => {
  const shotNode: PanelNode = {
    id: 's1',
    type: 'shot',
    data: {
      shotNo: 3,
      size: '特写',
      picture: '雨夜车窗',
      prompt: 'close-up, rain',
      refs: [{ id: 'r1', kind: 'character', label: '林晚垫图' }],
    },
  }

  it('镜号非法输入回退 1；引用位可改类型/文案、增删', () => {
    const { api } = setup(shotNode)
    fireEvent.change(screen.getByDisplayValue('3'), { target: { value: 'abc' } })
    expect(patchOf(api)).toEqual({ shotNo: 1 })

    // 非安全整数同属非法（§4.1 正安全整数域，落载后会被顺位重发）：同款回退 1
    fireEvent.change(screen.getByDisplayValue('3'), { target: { value: '100000000000000000000' } })
    expect(patchOf(api, 1)).toEqual({ shotNo: 1 })

    fireEvent.change(screen.getByRole('combobox', { name: '引用类型' }), {
      target: { value: 'audio' },
    })
    const refs = patchOf(api, 2).refs as Array<{ kind: string }>
    expect(refs[0].kind).toBe('audio')

    fireEvent.click(screen.getByRole('button', { name: '＋ 添加引用' }))
    const added = patchOf(api, 3).refs as Array<{ id: string; kind: string; label: string }>
    expect(added).toHaveLength(2)
    expect(added[1]).toMatchObject({ kind: 'character', label: '' })
    expect(added[1].id).toMatch(/^ref-/)

    fireEvent.click(screen.getAllByRole('button', { name: '删除此引用' })[0])
    expect(patchOf(api, 4).refs).toEqual([])
  })

  it('分镜卡不出集归属字段（随宿主场景派生）', () => {
    setup(shotNode)
    expect(screen.queryByPlaceholderText('未分集')).toBeNull()
  })

  it('资产引用位输入文字即转自由位：剥离 assetId，不产出双字段禁写形态', () => {
    const assetShot: PanelNode = {
      id: 's2',
      type: 'shot',
      data: {
        shotNo: 1,
        size: '中景',
        picture: '',
        prompt: '',
        refs: [{ id: 'r1', kind: 'character', assetId: 'a-1' }],
      },
    }
    const { api } = setup(assetShot)
    // 引用位显示资产 id 占位；输入文字即切换为自由位（§4.2 assetId/label 互斥——
    // 双字段形态保存成功但下次加载被归一化静默删除）
    fireEvent.change(screen.getByPlaceholderText(/a-1/), { target: { value: '人物垫图' } })
    expect(patchOf(api).refs).toEqual([{ id: 'r1', kind: 'character', label: '人物垫图' }])
  })
})

describe('面板动作', () => {
  it('⧉ 复制 / 🗑 删除透传节点 id', () => {
    const { api } = setup(sceneNode)
    fireEvent.click(screen.getByRole('button', { name: '⧉ 复制' }))
    expect(api.duplicateNode).toHaveBeenCalledWith('n1')
    fireEvent.click(screen.getByRole('button', { name: '🗑 删除' }))
    expect(api.deleteNode).toHaveBeenCalledWith('n1')
  })
})

describe('EditableName', () => {
  it('双击进入编辑，Enter（blur）提交去空白的新名', () => {
    const onChange = vi.fn()
    render(<EditableName value="旧名" onChange={onChange} ariaLabel="节点名称" />)
    fireEvent.doubleClick(screen.getByRole('button', { name: '旧名' }))
    const input = screen.getByRole('textbox', { name: '节点名称' })
    fireEvent.change(input, { target: { value: '  新名  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith('新名')
  })

  it('Esc 取消；空值与未改名不提交', () => {
    const onChange = vi.fn()
    render(<EditableName value="旧名" onChange={onChange} ariaLabel="节点名称" />)
    fireEvent.doubleClick(screen.getByRole('button', { name: '旧名' }))
    let input = screen.getByRole('textbox', { name: '节点名称' })
    fireEvent.change(input, { target: { value: '被丢弃' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()

    fireEvent.doubleClick(screen.getByRole('button', { name: '旧名' }))
    input = screen.getByRole('textbox', { name: '节点名称' })
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('singleClick 模式单击进入编辑；键盘 Enter 也可进入', () => {
    const onChange = vi.fn()
    render(<EditableName value="项目" onChange={onChange} ariaLabel="项目名" singleClick />)
    fireEvent.click(screen.getByRole('button', { name: '项目' }))
    expect(screen.getByRole('textbox', { name: '项目名' })).toBeTruthy()

    cleanup()
    render(<EditableName value="节点" onChange={onChange} ariaLabel="节点名" />)
    fireEvent.keyDown(screen.getByRole('button', { name: '节点' }), { key: 'Enter' })
    expect(screen.getByRole('textbox', { name: '节点名' })).toBeTruthy()
  })
})
