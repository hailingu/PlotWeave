// @vitest-environment happy-dom
/**
 * 大纲拖拽落点 hook 测试（issue #235）：真实文档状态 + 补丁写通道 +
 * 命令栈的集成 harness（与 useEditorGraphActions 生产装配同构）。
 * 断言拖放后的完整图状态与历史操作结果：同集重排（缝合缺口）、
 * 跨集与未分集移动的 episodeNo 补丁、非编剧四类/不存在节点拒绝、
 * 无变化不入栈，以及边手术 + episodeNo 一步 undo/redo——不以 mock
 * 被调用代替图状态证据。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Edge } from '@xyflow/react'
import {
  useEditorDocument,
  type EditorProjectContent,
} from './useEditorDocument'
import { useNodePatch } from './useNodePatch'
import { useOutlineDrop } from './useOutlineDrop'
import type { HistoryCommand } from './history'
import type {
  CanvasNode,
  ImageFlowNode,
  SceneFlowNode,
  ShotFlowNode,
} from './nodes/types'

function sceneNode(
  id: string,
  episodeNo: number | undefined,
  x: number,
): SceneFlowNode {
  return {
    id,
    type: 'scene',
    position: { x, y: 0 },
    data: {
      name: id,
      sceneNo: 1,
      interior: true,
      time: '夜',
      synopsis: '…',
      characterIds: [],
      ...(episodeNo !== undefined ? { episodeNo } : {}),
    },
  }
}

function looseShotNode(id: string): ShotFlowNode {
  return {
    id,
    type: 'shot',
    position: { x: 0, y: 0 },
    data: { shotNo: 1, size: '中景', picture: '', prompt: '', refs: [] },
  }
}

function looseImageNode(id: string): ImageFlowNode {
  return {
    id,
    type: 'image',
    position: { x: 0, y: 0 },
    data: { prompt: '', model: '', size: '1:1', outputs: {} },
  }
}

const seq = (id: string, source: string, target: string): Edge => ({
  id,
  source,
  target,
  className: 'pw-edge-sequence',
})

/** 与 useEditorGraphActions 生产装配同构的集成 harness：真实文档状态、
 * 真实 applyDataPatch 写通道（纯状态写入），命令栈以 spy 记录。 */
function setup(nodes: CanvasNode[], edges: Edge[]) {
  const project: EditorProjectContent = {
    id: 'p1',
    name: '测试项目',
    nodes,
    edges,
    settings: { characters: [], locations: [] },
  }
  const commands: HistoryCommand[] = []
  const pushHistory = vi.fn((cmd: HistoryCommand) => commands.push(cmd))
  const { result } = renderHook(() => {
    const doc = useEditorDocument(project)
    const patch = useNodePatch(doc, pushHistory)
    const outlineDrop = useOutlineDrop({
      nodesRef: doc.nodesRef,
      edgesRef: doc.edgesRef,
      episodeTitlesRef: doc.episodeTitlesRef,
      applyDataPatch: patch.applyDataPatch,
      setEdges: doc.setEdges,
      pushHistory,
    })
    return { doc, outlineDrop }
  })
  return { result, commands, pushHistory }
}

type Harness = ReturnType<typeof setup>

/** sequence 边的 source→target 对（新增边 id 含时间戳，断言用端点对）。 */
const seqPairs = (h: Harness) =>
  h.result.current.doc.edges.map((e) => `${e.source}->${e.target}`)

const episodeNoOf = (h: Harness, id: string) =>
  (
    h.result.current.doc.nodes.find((n) => n.id === id)?.data as {
      episodeNo?: number
    }
  )?.episodeNo

/** 行落点调用（单行形）：anchor 为锚点行，position 为相对锚点位置。 */
const dropRow = (
  h: Harness,
  dragged: string,
  anchor: string,
  position: 'before' | 'after',
) =>
  h.result.current.outlineDrop(dragged, {
    kind: 'row',
    anchorId: anchor,
    position,
  })

describe('useOutlineDrop（§3.5 同集重排与拒绝路径）', () => {
  it('同集后移：缝合缺口重排 sequence 边，episodeNo 不动，单命令 undo/redo', () => {
    const h = setup(
      [sceneNode('s1', 1, 0), sceneNode('s2', 1, 100), sceneNode('s3', 1, 200)],
      [seq('e1', 's1', 's2'), seq('e2', 's2', 's3')],
    )
    act(() => dropRow(h, 's2', 's3', 'after'))
    // s1→s2→s3 后移 s2 到组尾：缝合 s1→s3，接回 s3→s2
    expect(seqPairs(h)).toEqual(['s1->s3', 's3->s2'])
    expect(episodeNoOf(h, 's2')).toBe(1)
    expect(h.pushHistory).toHaveBeenCalledTimes(1)
    const moved = h.result.current.doc.edges.find((e) => e.source === 's3')
    expect(moved?.className).toBe('pw-edge-sequence')

    act(() => h.commands[0].undo())
    expect(seqPairs(h)).toEqual(['s1->s2', 's2->s3'])
    act(() => h.commands[0].redo())
    expect(seqPairs(h)).toEqual(['s1->s3', 's3->s2'])
  })

  it('拒绝分镜卡与图片节点：不入栈不写状态', () => {
    const nodes = [
      sceneNode('s1', 1, 0),
      looseShotNode('sh1'),
      looseImageNode('img1'),
    ]
    const h = setup(nodes, [seq('e1', 's1', 's1')])
    act(() => dropRow(h, 'sh1', 's1', 'after'))
    act(() => dropRow(h, 'img1', 's1', 'after'))
    expect(h.result.current.doc.nodes).toHaveLength(3)
    expect(seqPairs(h)).toEqual(['s1->s1'])
    expect(h.pushHistory).not.toHaveBeenCalled()
  })

  it('不存在的节点 id：不入栈不写状态', () => {
    const h = setup([sceneNode('s1', 1, 0)], [])
    act(() => dropRow(h, 'ghost', 's1', 'after'))
    expect(h.pushHistory).not.toHaveBeenCalled()
    expect(h.result.current.doc.nodes).toHaveLength(1)
  })

  it('原位重放（无可执行变化）：不入栈不写状态', () => {
    const h = setup(
      [sceneNode('s1', 1, 0), sceneNode('s2', 1, 100), sceneNode('s3', 1, 200)],
      [seq('e1', 's1', 's2'), seq('e2', 's2', 's3')],
    )
    // s2 拖回自身原位（锚 s1 之后）＝ 原位重放，计划为空且集归属不变
    act(() => dropRow(h, 's2', 's1', 'after'))
    expect(seqPairs(h)).toEqual(['s1->s2', 's2->s3'])
    expect(episodeNoOf(h, 's2')).toBe(1)
    expect(h.pushHistory).not.toHaveBeenCalled()
  })
})

describe('useOutlineDrop（§3.5 跨集与未分集移动单命令）', () => {
  it('跨集行落点：边手术 + episodeNo 补丁同命令一步撤销', () => {
    const h = setup(
      [sceneNode('s1', 1, 0), sceneNode('s2', 1, 100), sceneNode('x', 2, 300)],
      [seq('e1', 's1', 's2')],
    )
    act(() => dropRow(h, 'x', 's2', 'after'))
    expect(seqPairs(h)).toEqual(['s1->s2', 's2->x'])
    expect(episodeNoOf(h, 'x')).toBe(1)

    act(() => h.commands[0].undo())
    expect(seqPairs(h)).toEqual(['s1->s2'])
    expect(episodeNoOf(h, 'x')).toBe(2)
    act(() => h.commands[0].redo())
    expect(seqPairs(h)).toEqual(['s1->s2', 's2->x'])
    expect(episodeNoOf(h, 'x')).toBe(1)
  })

  it('未分集 → 组尾落点：进组写 episodeNo；undo 清回未分集', () => {
    const h = setup(
      [
        sceneNode('s1', 1, 0),
        sceneNode('s2', 1, 100),
        sceneNode('u', undefined, 300),
      ],
      [seq('e1', 's1', 's2')],
    )
    act(() =>
      h.result.current.outlineDrop('u', { kind: 'groupEnd', episode: 1 }),
    )
    expect(seqPairs(h)).toEqual(['s1->s2', 's2->u'])
    expect(episodeNoOf(h, 'u')).toBe(1)

    act(() => h.commands[0].undo())
    expect(seqPairs(h)).toEqual(['s1->s2'])
    expect(episodeNoOf(h, 'u')).toBeUndefined()
  })

  it('集 → 未分集组尾：episodeNo 清除；undo 恢复集归属与原边', () => {
    const h = setup(
      [
        sceneNode('s1', 1, 0),
        sceneNode('u1', undefined, 100),
        sceneNode('u2', undefined, 200),
      ],
      [seq('e1', 's1', 'u1'), seq('e2', 'u1', 'u2')],
    )
    act(() =>
      h.result.current.outlineDrop('s1', { kind: 'groupEnd', episode: null }),
    )
    expect(seqPairs(h)).toEqual(['u1->u2', 'u2->s1'])
    expect(episodeNoOf(h, 's1')).toBeUndefined()

    act(() => h.commands[0].undo())
    expect(seqPairs(h)).toEqual(['u1->u2', 's1->u1'])
    expect(episodeNoOf(h, 's1')).toBe(1)
  })
})
