// @vitest-environment happy-dom
/**
 * 节点删除 hook 测试（issue #234）：真实文档状态 + 资产索引 + 命令栈的
 * 集成 harness（与 useGraphDeletion 生产装配同构）。断言可观察级联状态：
 * 节点与相邻边删除、空目标不入栈、独占图片产物移出索引、共享资产保留、
 * 单一复合命令 undo/redo 往返恢复（含资产索引）——不以 mock 被调用
 * 代替级联状态证据。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Edge } from '@xyflow/react'
import {
  useEditorDocument,
  type EditorProjectContent,
} from './useEditorDocument'
import { useAssetIndex } from './useAssetIndex'
import { useNodeDeletion } from './useNodeDeletion'
import type { HistoryCommand } from './history'
import type { AssetRef } from '../model/document'
import type { ProjectSettings } from './settings'
import type { CanvasNode } from './nodes/types'

function sceneNode(id: string): CanvasNode {
  return {
    id,
    type: 'scene',
    position: { x: 0, y: 0 },
    data: {
      name: id,
      sceneNo: 1,
      interior: true,
      time: '日',
      synopsis: '',
      characterIds: [],
    },
  }
}

function imageNode(id: string, primaryAssetId?: string): CanvasNode {
  return {
    id,
    type: 'image',
    position: { x: 0, y: 0 },
    data: {
      prompt: '',
      model: '',
      size: '1:1',
      outputs:
        primaryAssetId === undefined
          ? {}
          : { primary: { assetId: primaryAssetId } },
    },
  }
}

function shotNode(id: string, refAssetIds: string[]): CanvasNode {
  return {
    id,
    type: 'shot',
    position: { x: 0, y: 0 },
    data: {
      shotNo: 1,
      size: '中景',
      picture: '',
      prompt: '',
      refs: refAssetIds.map((assetId, i) => ({
        id: `r${i}`,
        kind: 'character' as const,
        assetId,
      })),
    },
  }
}

function asset(id: string): AssetRef {
  return {
    id,
    relPath: `projects/p1/assets/${id}.png`,
    mime: 'image/png',
    source: 'generated',
    createdAt: '2026-09-21T00:00:00.000Z',
  }
}

/** avatarAssetId 是落盘模型的演进字段（CharacterEntity 未声明、serialize
 * 整对象透传、运行时可携带）：与 imagegen 测试同口径经 as unknown 宽化。 */
const avatarCharacters = [
  { id: 'ch1', name: '主角', gradient: 'g', avatarAssetId: 'pa-avatar' },
] as unknown as ProjectSettings['characters']

interface HarnessInput {
  nodes: CanvasNode[]
  edges?: Edge[]
  characters?: ProjectSettings['characters']
  assets?: { byId: Record<string, AssetRef> }
}

/** 与 useGraphDeletion 生产装配同构的集成 harness：真实文档状态、
 * 真实资产索引写通道，命令栈与面板收起以 spy 记录。 */
function setup(input: HarnessInput) {
  const project: EditorProjectContent = {
    id: 'p1',
    name: '测试项目',
    nodes: input.nodes,
    edges: input.edges ?? [],
    settings: {
      characters: input.characters ?? [],
      locations: [],
    },
    assets: input.assets,
  }
  const commands: HistoryCommand[] = []
  const pushHistory = vi.fn((cmd: HistoryCommand) => commands.push(cmd))
  const closeSettings = vi.fn()
  const { result } = renderHook(() => {
    const doc = useEditorDocument(project)
    const assets = useAssetIndex(doc.setAssets)
    const deleteNodesByIds = useNodeDeletion({
      nodesRef: doc.nodesRef,
      edgesRef: doc.edgesRef,
      settings: doc.settings,
      assetsRef: doc.assetsRef,
      addAsset: assets.addAsset,
      removeAsset: assets.removeAsset,
      setNodes: doc.setNodes,
      setEdges: doc.setEdges,
      pushHistory,
      closeSettings,
    })
    return { doc, deleteNodesByIds }
  })
  return { result, commands, pushHistory, closeSettings }
}

type Harness = ReturnType<typeof setup>

const nodeIds = (h: Harness) => h.result.current.doc.nodes.map((n) => n.id)
const edgeIds = (h: Harness) => h.result.current.doc.edges.map((e) => e.id)
const assetIds = (h: Harness) =>
  Object.keys(h.result.current.doc.assets?.byId ?? {})

describe('useNodeDeletion（§4.3/§7.3 删除与资产级联可撤销）', () => {
  it('删除选中节点并清理相邻边；幸存者间连线保留，收起设定面板', () => {
    const h = setup({
      nodes: [sceneNode('s1'), sceneNode('s2'), imageNode('img1')],
      edges: [
        { id: 'e-keep', source: 's2', target: 'img1' },
        { id: 'e-drop-a', source: 's1', target: 's2' },
        { id: 'e-drop-b', source: 's1', target: 'img1' },
      ],
    })
    act(() => h.result.current.deleteNodesByIds(['s1']))
    expect(nodeIds(h)).toEqual(['s2', 'img1'])
    expect(edgeIds(h)).toEqual(['e-keep'])
    expect(h.pushHistory).toHaveBeenCalledTimes(1)
    expect(h.closeSettings).toHaveBeenCalledTimes(1)
  })

  it('无匹配目标：不写状态、不入栈、不收面板', () => {
    const h = setup({
      nodes: [sceneNode('s1')],
      edges: [{ id: 'e1', source: 's1', target: 's1' }],
    })
    act(() => h.result.current.deleteNodesByIds(['ghost', 's-missing']))
    expect(nodeIds(h)).toEqual(['s1'])
    expect(edgeIds(h)).toEqual(['e1'])
    expect(h.pushHistory).not.toHaveBeenCalled()
    expect(h.closeSettings).not.toHaveBeenCalled()
  })

  it('独占产物移出索引；仍被分镜引用或角色头像占用的资产保留', () => {
    const h = setup({
      nodes: [
        imageNode('img-solo', 'pa-solo'),
        imageNode('img-shared', 'pa-shared'),
        imageNode('img-avatar', 'pa-avatar'),
        shotNode('shot1', ['pa-shared']),
      ],
      characters: avatarCharacters,
      assets: {
        byId: {
          'pa-solo': asset('pa-solo'),
          'pa-shared': asset('pa-shared'),
          'pa-avatar': asset('pa-avatar'),
        },
      },
    })
    act(() =>
      h.result.current.deleteNodesByIds([
        'img-solo',
        'img-shared',
        'img-avatar',
      ]),
    )
    expect(nodeIds(h)).toEqual(['shot1'])
    expect(assetIds(h)).toEqual(['pa-shared', 'pa-avatar'])
  })

  it('单一复合命令：undo 恢复节点/边/资产，redo 再删', () => {
    const h = setup({
      nodes: [sceneNode('s1'), sceneNode('s2'), imageNode('img1', 'pa-solo')],
      edges: [
        { id: 'e1', source: 's1', target: 's2' },
        { id: 'e2', source: 's2', target: 'img1' },
      ],
      assets: { byId: { 'pa-solo': asset('pa-solo') } },
    })
    act(() => h.result.current.deleteNodesByIds(['s1', 'img1']))
    expect(nodeIds(h)).toEqual(['s2'])
    expect(edgeIds(h)).toEqual([])
    expect(assetIds(h)).toEqual([])
    expect(h.commands).toHaveLength(1)

    // 既有语义：undo 把被删节点/边追加到末尾（非原位插回），此处守护不变
    act(() => h.commands[0].undo())
    expect(nodeIds(h)).toEqual(['s2', 's1', 'img1'])
    expect(edgeIds(h)).toEqual(['e1', 'e2'])
    expect(assetIds(h)).toEqual(['pa-solo'])

    act(() => h.commands[0].redo())
    expect(nodeIds(h)).toEqual(['s2'])
    expect(edgeIds(h)).toEqual([])
    expect(assetIds(h)).toEqual([])
  })

  it('资产索引未加载（undefined）：删除与撤销正常执行且不触碰资产', () => {
    const h = setup({ nodes: [imageNode('img1', 'pa-x'), sceneNode('s1')] })
    act(() => h.result.current.deleteNodesByIds(['img1']))
    expect(nodeIds(h)).toEqual(['s1'])
    expect(h.pushHistory).toHaveBeenCalledTimes(1)
    act(() => h.commands[0].undo())
    expect(nodeIds(h)).toEqual(['s1', 'img1'])
  })
})
