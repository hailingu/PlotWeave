import { describe, expect, expectTypeOf, it } from 'vitest'
import { fromStoryNode, toStoryNode } from './serialize'
import type {
  BeatDocNode,
  BranchDocNode,
  DerivedMeta,
  LabeledMeta,
  SceneDocNode,
  SceneSpec,
  ShotMeta,
  ShotSpec,
} from './document'
import type { SceneFlowNode, SceneNodeData, ShotFlowNode } from '../editor/nodes/types'

/** 场景运行态节点（§4.2 字段）。 */
function sceneFlowNode(): SceneFlowNode {
  return {
    id: 's1',
    type: 'scene',
    position: { x: 1, y: 2 },
    width: 320,
    height: 180,
    zIndex: 3,
    data: {
      name: '天台',
      sceneNo: 3,
      interior: false,
      time: '🌙 夜',
      weather: '雨',
      synopsis: '…',
      characterIds: ['c1'],
      episodeNo: 2,
    },
  }
}

/** 场景落盘节点（meta/spec 四分区）。 */
function sceneDocNode(): SceneDocNode {
  return {
    id: 's1',
    type: 'scene',
    layout: { position: { x: 1, y: 2 }, size: { width: 320, height: 180 }, zIndex: 3 },
    ui: { selected: true, expanded: false },
    data: {
      spec: {
        sceneNo: 3,
        interior: false,
        time: '🌙 夜',
        weather: '雨',
        synopsis: '…',
        characterIds: ['c1'],
      },
      meta: { label: '天台', episodeNo: 2, createdAt: '2026-01-01T00:00:00.000Z' },
    },
  }
}

describe('toStoryNode（issue 16：按节点类型精确构造落盘联合成员）', () => {
  it('场景节点产出 SceneDocNode：spec/meta 形状锁定，meta.label 必填', () => {
    const doc = toStoryNode(sceneFlowNode())
    if (doc.type !== 'scene') throw new Error('判别失败')
    expectTypeOf(doc).toEqualTypeOf<SceneDocNode>()
    expectTypeOf(doc.data.spec).toEqualTypeOf<SceneSpec>()
    expectTypeOf(doc.data.meta).toEqualTypeOf<LabeledMeta>()
    expect(doc.data.spec).toEqual({
      sceneNo: 3,
      interior: false,
      time: '🌙 夜',
      weather: '雨',
      synopsis: '…',
      characterIds: ['c1'],
    })
    expect(doc.data.meta).toEqual({ label: '天台', episodeNo: 2 })
  })

  it('meta 按 type 判别：branch 不落 label 镜像，shot/image 连 episodeNo 也不落', () => {
    // branch 的 DerivedMeta 以 label?: never 结构性禁写；shot 的 ShotMeta
    // 再禁 episodeNo——误写镜像在编译期拒绝（由 tsc 把关，不设运行时断言）
    const branchMeta: DerivedMeta = { episodeNo: 1 }
    // @ts-expect-error —— DerivedMeta 禁写 label（派生标题节点不落镜像）
    branchMeta.label = 'x'
    const shotMeta: ShotMeta = {}
    // @ts-expect-error —— ShotMeta 禁写 episodeNo（分镜卡随宿主场景分集）
    shotMeta.episodeNo = 1
    expectTypeOf<BeatDocNode['data']['meta']>().toEqualTypeOf<LabeledMeta>()
    expectTypeOf<BranchDocNode['data']['spec']['prompt']>().toEqualTypeOf<string>()
  })

  it('分镜卡：data 即 ShotSpec（ShotNodeData 与落盘 spec 同构）', () => {
    const shot: ShotFlowNode = {
      id: 'sh1',
      type: 'shot',
      position: { x: 0, y: 0 },
      data: { shotNo: 2, size: '中景', picture: '…', prompt: '', refs: [] },
    }
    const doc = toStoryNode(shot)
    if (doc.type !== 'shot') throw new Error('判别失败')
    expectTypeOf(doc.data.spec).toEqualTypeOf<ShotSpec>()
    expectTypeOf(doc.data.meta).toEqualTypeOf<ShotMeta>()
    expect(doc.data.spec).toEqual({ shotNo: 2, size: '中景', picture: '…', prompt: '', refs: [] })
  })

  it('分镜卡落盘剥离运行态混入的过期 episodeNo/name（随宿主场景分集，§3.5）', () => {
    // v1 文档残留的 spec.episodeNo 经归一化透传、fromStoryNode 拍平后可混入
    // 运行态 shot data（Record 索引签名允许）；落盘必须剥离——否则写回 spec
    // 后 episodeOfNode 优先读它而非宿主场景，错集归属永远无法被保存修复
    const shot: ShotFlowNode = {
      id: 'sh1',
      type: 'shot',
      position: { x: 0, y: 0 },
      data: { shotNo: 2, size: '中景', picture: '…', prompt: '', refs: [], episodeNo: 7, name: 'x' },
    }
    const doc = toStoryNode(shot)
    if (doc.type !== 'shot') throw new Error('判别失败')
    expect(doc.data.spec).toEqual({ shotNo: 2, size: '中景', picture: '…', prompt: '', refs: [] })
    expect('episodeNo' in doc.data.spec).toBe(false)
    expect('name' in doc.data.spec).toBe(false)
  })
})

describe('fromStoryNode（issue 16：落盘 → 运行态按类型构造）', () => {
  it('场景节点 data 精确还原 SceneNodeData：spec 拍平 + meta.label→name', () => {
    const flow = fromStoryNode(sceneDocNode())
    if (flow.type !== 'scene') throw new Error('判别失败')
    expectTypeOf(flow.data).toEqualTypeOf<SceneNodeData>()
    expect(flow.data).toEqual({
      name: '天台',
      sceneNo: 3,
      interior: false,
      time: '🌙 夜',
      weather: '雨',
      synopsis: '…',
      characterIds: ['c1'],
      episodeNo: 2,
    })
    // 运行态契约字段：selected 恒为 false（§11.2），layout.size→width/height
    expect(flow.selected).toBe(false)
    expect(flow.width).toBe(320)
    expect(flow.height).toBe(180)
    expect(flow.zIndex).toBe(3)
    expect(flow.meta).toEqual({ createdAt: '2026-01-01T00:00:00.000Z' })
  })

  it('存储可选 time 缺省时兜底空串（与 normalizeSceneTextFields 同域）', () => {
    const doc = sceneDocNode()
    delete doc.data.spec.time
    const flow = fromStoryNode(doc)
    if (flow.type !== 'scene') throw new Error('判别失败')
    expect(flow.data.time).toBe('')
  })
})
