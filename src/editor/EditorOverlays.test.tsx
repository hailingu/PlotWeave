// @vitest-environment happy-dom
/**
 * 浮层区域输入边界契约（issue #104）：EditorOverlays 只凭真实消费的四个域
 * （project/doc/panels/graph）独立挂载与验证——右键菜单与导出对话框的渲染
 * 与动作不依赖 AI 会话、保存回调等布局层其余输入。越界字段由编译器拒绝：
 * 本文件按收窄接口装配本身即边界回归，接口一旦回退为整包 EditorLayoutProps，
 * 这里的四域装配将无法通过 tsc；行为用例守护收窄前后语义不变。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorOverlays, type EditorOverlaysProps } from './EditorOverlays'
import type { EditorDocument, EditorProjectContent } from './useEditorDocument'

afterEach(cleanup)

/** buildScriptExport 调用计数间谍（issue #158）：包装真实实现守护
 * 「无关渲染不重建」的缓存语义，行为断言仍走真实导出。 */
const buildSpy = vi.hoisted(() => vi.fn())
vi.mock('./exportScript', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./exportScript')>()
  return {
    ...mod,
    buildScriptExport: (input: Parameters<typeof mod.buildScriptExport>[0]) => {
      buildSpy()
      return mod.buildScriptExport(input)
    },
  }
})

/** 打开的项目（结构同装配层下传；浮层只读 name）。 */
const PROJECT: EditorProjectContent = {
  id: 'p1',
  name: '浮层边界',
  nodes: [],
  edges: [],
  settings: { characters: [], locations: [] },
}

/** 最小文档夹具：只填浮层真实读取的字段（导出正文、资产与集标题）。 */
const DOC = {
  nodes: [],
  edges: [],
  settings: { characters: [], locations: [] },
  assets: undefined,
  episodeTitles: {},
} as unknown as EditorDocument

/** 以真实消费域装配浮层输入；浮层开关与动作间谍按用例注入。 */
function setup(
  over: {
    ctxMenu?: EditorOverlaysProps['panels']['ctxMenu']
    exportOpen?: boolean
  } = {},
) {
  const actions = {
    toggleSettings: vi.fn(),
    setCtxMenu: vi.fn(),
    setExportOpen: vi.fn(),
    duplicateNode: vi.fn(),
    createNode: vi.fn(),
    deleteNodesByIds: vi.fn(),
    deleteEdgesByIds: vi.fn(),
  }
  const props: EditorOverlaysProps = {
    project: PROJECT,
    doc: DOC,
    panels: {
      ctxMenu: over.ctxMenu ?? null,
      toggleSettings: actions.toggleSettings,
      setCtxMenu: actions.setCtxMenu,
      exportOpen: over.exportOpen ?? false,
      setExportOpen: actions.setExportOpen,
    } as unknown as EditorOverlaysProps['panels'],
    graph: {
      creation: {
        duplicateNode: actions.duplicateNode,
        createNode: actions.createNode,
      },
      deleteNodesByIds: actions.deleteNodesByIds,
      deleteEdgesByIds: actions.deleteEdgesByIds,
    } as unknown as EditorOverlaysProps['graph'],
  }
  return { actions, props, view: render(<EditorOverlays {...props} />) }
}

describe('EditorOverlays 输入边界（issue #104）', () => {
  it('两个浮层都关闭时不渲染任何浮层内容', () => {
    const { view } = setup()
    expect(view.container.firstChild).toBeNull()
  })

  it('节点右键菜单：动作路由到 graph/panels，每个动作后收起', () => {
    const { actions } = setup({ ctxMenu: { x: 8, y: 12, nodeId: 'n1' } })
    fireEvent.click(screen.getByText('⚙️ 打开设置'))
    expect(actions.toggleSettings).toHaveBeenCalledWith('n1')
    fireEvent.click(screen.getByText('⧉ 复制'))
    expect(actions.duplicateNode).toHaveBeenCalledWith('n1')
    fireEvent.click(screen.getByText('🗑 删除'))
    expect(actions.deleteNodesByIds).toHaveBeenCalledWith(['n1'])
    expect(actions.setCtxMenu).toHaveBeenCalledWith(null)
    expect(actions.setCtxMenu).toHaveBeenCalledTimes(3)
  })

  it('导出对话框：以 project.name 命名，关闭路由到 setExportOpen(false)', () => {
    const { actions } = setup({ exportOpen: true })
    expect(screen.getByText('浮层边界-剧本.md')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('关闭'))
    expect(actions.setExportOpen).toHaveBeenCalledWith(false)
  })

  it('导出模型按内容依赖缓存（issue #158）：无关重渲染不重建，内容变化才重建', () => {
    buildSpy.mockClear()
    const { view, props } = setup({ exportOpen: true })
    expect(buildSpy).toHaveBeenCalledTimes(1)

    // 无关布局重渲染（props 不变的重演）：模型复用，不得逐渲染重建
    view.rerender(<EditorOverlays {...props} />)
    expect(buildSpy).toHaveBeenCalledTimes(1)

    // 内容变化（新增场景 → nodes 引用更换）：实时预览语义下重建，
    // 预览与下载继续共读同一模型
    const withScene = {
      ...props.doc,
      nodes: [
        {
          id: 's1',
          type: 'scene',
          position: { x: 0, y: 0 },
          data: { name: '场 01', sceneNo: 1, interior: true, characterIds: [] },
        } as unknown as EditorDocument['nodes'][number],
      ],
    } as EditorDocument
    view.rerender(<EditorOverlays {...props} doc={withScene} />)
    expect(buildSpy).toHaveBeenCalledTimes(2)
  })
})
