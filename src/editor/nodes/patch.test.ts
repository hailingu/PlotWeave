import { describe, expect, expectTypeOf, it } from 'vitest'
import type { BatchValidation } from '../ai/commands'
import type { ValidatedCommand } from '../ai/commands'
import {
  dataPatchOf,
  episodeNoPatch,
  mergeNodeData,
  type NodeDataPatch,
  type PatchShape,
} from './patch'
import type {
  SceneFlowNode,
  SceneNodeData,
  ShotFlowNode,
} from './types'

/** 分镜卡测试节点（mergeNodeData 的宿主形态）。 */
function shotNode(): ShotFlowNode {
  return {
    id: 'sh1',
    type: 'shot',
    position: { x: 0, y: 0 },
    data: { shotNo: 1, size: '中景', picture: '…', prompt: '', refs: [] },
  }
}

/** 场景测试节点。 */
function sceneNode(): SceneFlowNode {
  return {
    id: 's1',
    type: 'scene',
    position: { x: 0, y: 0 },
    data: {
      name: '天台',
      sceneNo: 3,
      interior: false,
      time: '🌙 夜',
      synopsis: '…',
      characterIds: [],
    },
  }
}

describe('NodeDataPatch（issue 16：补丁命令按节点类型判别绑定）', () => {
  it('同类型字段补丁合法，patch 与该类型 data 形状绑定', () => {
    const cmd: NodeDataPatch = { nodeType: 'scene', patch: { synopsis: '雨夜', sceneNo: 4 } }
    expect(cmd.nodeType).toBe('scene')
    expectTypeOf<Extract<NodeDataPatch, { nodeType: 'scene' }>['patch']>().toEqualTypeOf<
      PatchShape<SceneNodeData>
    >()
  })

  it('跨类型字段（scene 补丁携带对白的 lines）无法编译', () => {
    // @ts-expect-error —— scene 补丁携带对白字段，判别成员形状检查拒绝
    const cross: NodeDataPatch = { nodeType: 'scene', patch: { lines: [] } }
    expect(cross).toBeDefined()
  })

  it('同名字段异型值无法编译（sceneNo 须为 number）', () => {
    // @ts-expect-error —— sceneNo 的补丁值须为 number
    const bad: NodeDataPatch = { nodeType: 'scene', patch: { sceneNo: '4' } }
    expect(bad).toBeDefined()
  })

  it('AI 执行通道（ValidatedCommand）的 update_node 补丁为判别化形态', () => {
    type ValidatedUpdate = Extract<ValidatedCommand, { op: 'update_node' }>
    expectTypeOf<ValidatedUpdate['patch']>().toEqualTypeOf<NodeDataPatch>()
    expectTypeOf<BatchValidation['commands'][number]>().toEqualTypeOf<ValidatedCommand>()
  })

  it('执行通道不接受宽 Record 补丁', () => {
    // @ts-expect-error —— 缺 nodeType 判别字段的宽补丁不得进入执行/撤销路径
    const wide: ValidatedCommand = { op: 'update_node', nodeId: 'n1', patch: { synopsis: 'x' } }
    expect(wide).toBeDefined()
  })
})

describe('dataPatchOf（受控构造出口：运行态类型字串 → 判别命令）', () => {
  it('绑定节点类型与已校验补丁', () => {
    expect(dataPatchOf('scene', { synopsis: '雨夜' })).toEqual({
      nodeType: 'scene',
      patch: { synopsis: '雨夜' },
    })
  })
})

describe('episodeNoPatch（§3.5 分集补丁：可分集的编剧侧四类构造）', () => {
  it('按节点类型分派 episodeNo 补丁', () => {
    expect(episodeNoPatch('scene', 2)).toEqual({ nodeType: 'scene', patch: { episodeNo: 2 } })
    expect(episodeNoPatch('dialogue', 1)).toEqual({ nodeType: 'dialogue', patch: { episodeNo: 1 } })
  })

  it('清空分集 = episodeNo undefined（回退未分集）', () => {
    expect(episodeNoPatch('branch', undefined)).toEqual({
      nodeType: 'branch',
      patch: { episodeNo: undefined },
    })
  })
})

describe('mergeNodeData（运行态合并：applyDataPatch 与批量模拟共用）', () => {
  it('逐键覆盖 data，其余节点形态不变', () => {
    const node = shotNode()
    const merged = mergeNodeData(node, { prompt: 'new' })
    expect(merged).toEqual({ ...node, data: { ...node.data, prompt: 'new' } })
    expect(merged.id).toBe('sh1')
    expect(merged.type).toBe('shot')
  })

  it('场景节点合并 name 补丁', () => {
    const merged = mergeNodeData(sceneNode(), { name: '改名人' })
    expect((merged.data as SceneNodeData).name).toBe('改名人')
  })
})
