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
import { mkContent, NOW } from '../model/convertFixtures'
import { parseProject } from '../model/convert'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

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
  viewport: undefined,
  aiRevision: 0,
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
    view.rerender(
      <EditorOverlays {...props} doc={{ ...props.doc, focusedEpisode: 2 }} />,
    )
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

/** 从真实浮层中的 JSON 预览读取结构化数据，避免用序列化器计算期望值。 */
function jsonPreview() {
  fireEvent.change(screen.getByRole('combobox', { name: '导出格式' }), {
    target: { value: 'json' },
  })
  return JSON.parse(document.querySelector('.pw-export-pre')!.textContent!)
}

/** 含未保存内容、项目扩展与当前视口的会话，复用现有模型夹具。 */
function structuredExportInput() {
  const content = mkContent()
  const project = {
    ...PROJECT,
    description: '剧本简介',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-27T12:00:00.000Z',
    graphExtensions: { custom: { retained: true } },
    settingsExtensions: { custom: ['设定扩展'] },
    assetsExtensions: { custom: '资产扩展' },
  }
  const doc = {
    ...DOC,
    ...content,
    aiRevision: 3,
    assets: {
      byId: {
        image1: {
          id: 'image1',
          relPath: 'assets/image1.png',
          mime: 'image/png',
          source: 'upload',
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      },
    },
    viewport: { x: 12, y: 34, zoom: 1.5 },
  } as EditorDocument
  return { project, doc }
}

describe('EditorOverlays JSON 图契约', () => {
  // 若用 project 旧图代替 doc 会话图，未保存修改和分支路径会消失。
  it('保留当前图语义，按现有 ProjectDocument 契约完整读回', () => {
    const { view, props } = setup({ exportOpen: true })
    const { project, doc } = structuredExportInput()
    const original = structuredClone(doc)
    view.rerender(<EditorOverlays {...props} project={project} doc={doc} />)
    const exported = jsonPreview()
    expect(
      exported.graph.nodes.find((node: { id: string }) => node.id === 'br1')
        .data.spec.options,
    ).toEqual([
      { id: 'opt-1', label: '坦白' },
      { id: 'opt-2', label: '隐瞒' },
    ])
    expect(exported.graph.edges).toEqual([
      { id: 'e1', source: 's1', target: 'd1', data: { kind: 'sequence' } },
      {
        id: 'e2',
        source: 'br1',
        target: 'd1',
        sourceHandle: 'option-opt-2',
        data: { kind: 'branch' },
      },
      {
        id: 'e3',
        source: 's1',
        target: 'sh1',
        sourceHandle: 'shots',
        data: { kind: 'attach' },
      },
    ])
    const restored = parseProject(exported)
    expect(restored.warnings).toEqual([])
    expect(restored.content.nodes.map((node) => node.id)).toEqual([
      's1',
      'b1',
      'd1',
      'br1',
      'sh1',
    ])
    expect(restored.content.episodeTitles).toEqual({ 2: '摊牌' })
    expect(restored.content.settings.characters[0]?.name).toBe('林晚')
    expect(exported.graph.nodes[0].selected).toBeUndefined()
    expect(exported.graph.nodes[0].className).toBeUndefined()
    expect(exported.graph.nodes[0].ui.selected).toBe(false)
    expect(doc).toEqual(original)
  })
})

describe('EditorOverlays 跨日可复现导出（#501）', () => {
  // 导出时钟盖戳或 Markdown 注入当前日期会使跨日重开产出不同字节。
  it.each(['md', 'json'])(
    '同一文档跨日重开 %s 导出仍逐字节一致（#501）',
    (format) => {
      vi.useFakeTimers()
      vi.setSystemTime(NOW)
      const { view, props } = setup({ exportOpen: true })
      const { project, doc } = structuredExportInput()
      const input = { ...props, project, doc }
      view.rerender(<EditorOverlays {...input} />)
      fireEvent.change(screen.getByRole('combobox', { name: '导出格式' }), {
        target: { value: format },
      })
      const first = document.querySelector('.pw-export-pre')!.textContent
      view.rerender(
        <EditorOverlays
          {...input}
          panels={{ ...input.panels, exportOpen: false }}
        />,
      )
      vi.setSystemTime(new Date('2026-08-29T12:00:00.000Z'))
      view.rerender(<EditorOverlays {...input} />)
      fireEvent.change(screen.getByRole('combobox', { name: '导出格式' }), {
        target: { value: format },
      })
      expect(document.querySelector('.pw-export-pre')!.textContent).toBe(first)
    },
  )
})

describe('EditorOverlays JSON 元数据', () => {
  it('保留项目与扩展元数据、当前资产和视口，保留文档修改时间', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { view, props } = setup({ exportOpen: true })
    const { project, doc } = structuredExportInput()
    view.rerender(<EditorOverlays {...props} project={project} doc={doc} />)
    const exported = jsonPreview()
    expect(exported.project).toEqual({
      id: 'p1',
      name: '浮层边界',
      description: '剧本简介',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-27T12:00:00.000Z',
    })
    expect(exported.graph.viewport).toEqual({ x: 12, y: 34, zoom: 1.5 })
    expect(exported.graph.aiRevision).toBe(3)
    const restored = parseProject(exported).content
    expect(restored.assets?.byId.image1?.relPath).toBe('assets/image1.png')
    expect(restored.graphExtensions).toEqual({ custom: { retained: true } })
    expect(restored.settingsExtensions).toEqual({ custom: ['设定扩展'] })
    expect(restored.assetsExtensions).toEqual({ custom: '资产扩展' })
  })
})

describe('EditorOverlays JSON 时间往返与兼容（#501）', () => {
  // 回读若漏掉 updatedAt，再导出会改写元数据；当前图与扩展也必须保持不动点。
  it('JSON → parseProject → 再导出逐字节不变（#501）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { view, props } = setup({ exportOpen: true })
    const { project, doc } = structuredExportInput()
    view.rerender(<EditorOverlays {...props} project={project} doc={doc} />)
    const exported = jsonPreview()
    const first = document.querySelector('.pw-export-pre')!.textContent
    const restored = parseProject(exported)
    expect(restored.warnings).toEqual([])
    vi.setSystemTime(new Date('2026-08-29T12:00:00.000Z'))
    view.rerender(
      <EditorOverlays
        {...props}
        project={{ id: project.id, ...restored.content }}
        doc={{ ...DOC, ...restored.content } as EditorDocument}
      />,
    )
    expect(document.querySelector('.pw-export-pre')!.textContent).toBe(first)
  })

  // 兼容输入缺少修改时间时也不能把导出时刻伪装成文档修改时间。
  it.each([
    {
      createdAt: '2026-08-01T00:00:00.000Z',
      expected: '2026-08-01T00:00:00.000Z',
    },
    { createdAt: undefined, expected: '1970-01-01T00:00:00.000Z' },
  ])('缺修改时间时固定回退为 $expected（#501）', ({ createdAt, expected }) => {
    const { view, props } = setup({ exportOpen: true })
    view.rerender(
      <EditorOverlays {...props} project={{ ...PROJECT, createdAt }} />,
    )
    expect(jsonPreview().project.updatedAt).toBe(expected)
    expect(jsonPreview().project.createdAt).toBe(createdAt ?? expected)
  })
})

describe('EditorOverlays JSON 实时预览', () => {
  it('空图有效，实时内容变更替换 JSON，无关重渲染保持文本', () => {
    const { view, props } = setup({ exportOpen: true })
    expect(jsonPreview().graph.nodes).toEqual([])
    expect(jsonPreview().assets.byId).toEqual({})
    const doc = { ...DOC, ...mkContent() } as EditorDocument
    view.rerender(<EditorOverlays {...props} doc={doc} />)
    const changed = jsonPreview()
    expect(changed.graph.nodes[0].data.spec.synopsis).toBe('摊牌')
    view.rerender(<EditorOverlays {...props} doc={doc} />)
    expect(jsonPreview()).toEqual(changed)
  })
})
