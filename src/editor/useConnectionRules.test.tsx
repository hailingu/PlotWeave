// @vitest-environment happy-dom
/**
 * 连线校验与建立 hook（从 EditorWindow 搬迁的连线写域）：§4.3/§4.4 的拒绝
 * 规则必须与加载侧孤儿边规则对等（自环、重复边、成环、端点类型越界、
 * attach 宿主唯一），落线需带上语义字段并入栈可撤销。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Connection, Edge } from '@xyflow/react'
import { useEditorDocument, type EditorProjectContent } from './useEditorDocument'
import { useConnectionRules } from './useConnectionRules'
import type { HistoryCommand } from './history'
import type { CanvasNode } from './nodes/types'

const scene = (id: string): CanvasNode =>
  ({
    id,
    type: 'scene',
    position: { x: 0, y: 0 },
    data: { name: id, sceneNo: 1, characterIds: [], locationId: null },
  }) as unknown as CanvasNode

const shot = (id: string): CanvasNode =>
  ({ id, type: 'shot', position: { x: 0, y: 0 }, data: { shotNo: 1, refs: [] } }) as unknown as CanvasNode

const branch = {
  id: 'br1',
  type: 'branch',
  position: { x: 0, y: 0 },
  data: { prompt: '走哪条路', options: [{ id: 'o1', label: '上楼' }] },
} as unknown as CanvasNode

const PROJECT: EditorProjectContent = {
  id: 'p1',
  name: '测试项目',
  nodes: [scene('sc1'), scene('sc2'), scene('sc3'), shot('sh1'), shot('sh2'), branch],
  edges: [
    { id: 'e-sc1-sc2', source: 'sc1', target: 'sc2', className: 'pw-edge-sequence' },
    { id: 'e-sc2-sh1', source: 'sc2', target: 'sh1', sourceHandle: 'shots' },
  ],
  settings: { characters: [], locations: [] },
}

const conn = (source: string, target: string, sourceHandle?: string): Connection => ({
  source,
  target,
  sourceHandle: sourceHandle ?? null,
  targetHandle: null,
})

function setup(project: EditorProjectContent = PROJECT) {
  const commands: HistoryCommand[] = []
  const pushHistory = vi.fn((cmd: HistoryCommand) => commands.push(cmd))
  const { result } = renderHook(() => {
    const doc = useEditorDocument(project)
    return { doc, rules: useConnectionRules(doc, pushHistory) }
  })
  return { result, commands, pushHistory }
}

describe('useConnectionRules（§4.3/§4.4 连线规则）', () => {
  const rejected: Array<[string, Connection]> = [
    ['自环', conn('sc1', 'sc1')],
    ['重复边（同端点同端口）', conn('sc1', 'sc2')],
    ['成环', conn('sc2', 'sc1')],
    ['attach 宿主已被占用', conn('sc3', 'sh1', 'shots')],
    ['attach 端点越界（非 场景→分镜卡）', conn('sc3', 'sc2', 'shots')],
    ['分镜卡参与剧情流', conn('sh1', 'sc1')],
    ['分支以 sequence 连出', conn('br1', 'sc1')],
  ]

  it.each(rejected)('拒绝非法连线：%s', (_label, connection) => {
    const { result } = setup()
    expect(result.current.rules.isValidConnection(connection)).toBe(false)
  })

  it('放行合法连线：sequence / 分支选项出口 / 无宿主 attach', () => {
    const { result } = setup()
    expect(result.current.rules.isValidConnection(conn('sc2', 'sc3'))).toBe(true)
    expect(result.current.rules.isValidConnection(conn('br1', 'sc1', 'option-o1'))).toBe(true)
    expect(result.current.rules.isValidConnection(conn('sc3', 'sh2', 'shots'))).toBe(true)
  })

  it('onConnect 按端口建成 sequence 边并单步入栈可撤销', () => {
    const { result, commands } = setup()
    act(() => result.current.rules.onConnect(conn('sc2', 'sc3')))
    const added = result.current.doc.edges[result.current.doc.edges.length - 1] as Edge
    expect(added.id).toBe('e-sc2-out-sc3')
    expect(added.className).toBe('pw-edge-sequence')
    expect(commands).toHaveLength(1)

    act(() => commands[0].undo())
    expect(result.current.doc.edges.map((e) => e.id)).not.toContain('e-sc2-out-sc3')
    act(() => commands[0].redo())
    expect(result.current.doc.edges.map((e) => e.id)).toContain('e-sc2-out-sc3')
  })

  it('onConnect 按端口区分 branch 边与 attach 边', () => {
    const { result } = setup()
    act(() => result.current.rules.onConnect(conn('br1', 'sc1', 'option-o1')))
    expect(result.current.doc.edges[result.current.doc.edges.length - 1]).toMatchObject({
      type: 'branch',
    })
    act(() => result.current.rules.onConnect(conn('sc3', 'sh2', 'shots')))
    expect(result.current.doc.edges[result.current.doc.edges.length - 1]).toMatchObject({
      className: 'pw-edge-attach',
    })
  })
})
