import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { simulateBatch, type BatchOps } from './batchSim'
import type { ValidatedCommand } from './commands'
import type { CanvasNode, SceneFlowNode } from '../nodes/types'
import { EMPTY_SETTINGS, type ProjectSettings } from '../settings'

/**
 * upsert_document 的折叠模拟（issue 56）：文档改动经 setSettings 落地，
 * 与节点/实体改动折叠为同一复合命令（一步撤销/重做）；props 与未参与
 * 编辑的桶透传保真；relatedIds 的批内 ref 在执行期解析为真实 id。
 */

function sceneNode(id: string): SceneFlowNode {
  return {
    id,
    type: 'scene',
    position: { x: 0, y: 0 },
    data: { name: `场`, sceneNo: 1, interior: true, time: '🌙 夜', synopsis: '…', characterIds: [] },
  }
}

function mkOps(
  initialNodes: CanvasNode[] = [],
  initialSettings: ProjectSettings = EMPTY_SETTINGS,
) {
  const state = {
    nodes: [...initialNodes],
    edges: [] as Edge[],
    settings: initialSettings,
  }
  let seq = 0
  const ops: BatchOps = {
    buildNewNode: (type, opts) =>
      ({
        id: `new-${type}-${++seq}`,
        type,
        position: { x: 0, y: 0 },
        selected: opts?.selected,
        data: { ...(opts?.data ?? {}) },
      }) as CanvasNode,
    applyDataPatch: () => {},
    setNodes: () => {},
    setEdges: () => {},
    setSettings: (up) => {
      state.settings = up(state.settings)
    },
  }
  return { state, ops }
}

function settingsWithDocs(): ProjectSettings {
  return {
    characters: [{ id: 'ch-1', name: '陈默', gradient: 'g1' }],
    locations: [{ id: 'loc-1', name: '茶馆' }],
    props: [{ id: 'prop-1', name: '怀表' }],
    documents: [
      { id: 'doc-1', title: '世界观', body: '旧全文', relatedIds: [] },
      { id: 'doc-2', title: '术语表', body: '术语', relatedIds: [] },
    ],
  }
}

describe('simulateBatch · upsert_document 新建', () => {
  it('forward 追加文档（应用分配真实 id）、backward 移除；props 与其他文档原样', () => {
    const { state, ops } = mkOps([], settingsWithDocs())
    const { forward, backward } = simulateBatch(
      [
        {
          op: 'upsert_document',
          fields: { title: '陈默小传', body: '正文', relatedIds: [{ kind: 'character', id: 'ch-1' }] },
        },
      ] as unknown as ValidatedCommand[],
      ops,
      [],
      [],
      state.settings,
    )
    expect(state.settings.documents).toHaveLength(2)
    forward.forEach((f) => f())
    const docs = state.settings.documents ?? []
    expect(docs).toHaveLength(3)
    const created = docs.find((d) => d.title === '陈默小传')
    expect(created?.id).toMatch(/^doc-/)
    expect(created?.body).toBe('正文')
    expect(created?.relatedIds).toEqual([{ kind: 'character', id: 'ch-1' }])
    expect(state.settings.props).toEqual([{ id: 'prop-1', name: '怀表' }])
    expect(docs.find((d) => d.id === 'doc-1')).toMatchObject({ title: '世界观', body: '旧全文' })

    backward.forEach((f) => f())
    expect(state.settings.documents).toHaveLength(2)
    expect(state.settings.documents?.some((d) => d.title === '陈默小传')).toBe(false)
  })

  it('relatedIds 的批内 ref 解析为同批新建角色的真实 id；撤销-重做保持同一实体 id', () => {
    const { state, ops } = mkOps([], settingsWithDocs())
    const { forward, backward } = simulateBatch(
      [
        { op: 'upsert_character', ref: 'hero', fields: { name: '林晚' } },
        {
          op: 'upsert_document',
          fields: { title: '小传', relatedIds: [{ kind: 'character', id: 'hero' }] },
        },
      ] as unknown as ValidatedCommand[],
      ops,
      [],
      [],
      state.settings,
    )
    forward.forEach((f) => f())
    const heroId = state.settings.characters.find((c) => c.name === '林晚')?.id
    const doc = state.settings.documents?.find((d) => d.title === '小传')
    expect(doc?.relatedIds).toEqual([{ kind: 'character', id: heroId }])
    // 撤销-重做复用同一实体对象：引用不悬空
    backward.forEach((f) => f())
    forward.forEach((f) => f())
    expect(state.settings.documents?.find((d) => d.title === '小传')?.relatedIds).toEqual([
      { kind: 'character', id: heroId },
    ])
  })
})

describe('simulateBatch · upsert_document 修改', () => {
  it('只覆盖 fields 写到的键；未提及字段与同批其他文档保持不变', () => {
    const { state, ops } = mkOps([], settingsWithDocs())
    const before = settingsWithDocs().documents?.find((d) => d.id === 'doc-1')
    const { forward, backward } = simulateBatch(
      [
        { op: 'upsert_document', entityId: 'doc-1', fields: { body: '新全文' } },
      ] as unknown as ValidatedCommand[],
      ops,
      [],
      [],
      state.settings,
    )
    forward.forEach((f) => f())
    const after = state.settings.documents?.find((d) => d.id === 'doc-1')
    expect(after?.body).toBe('新全文')
    expect(after?.title).toBe(before?.title)
    expect(state.settings.documents?.find((d) => d.id === 'doc-2')?.body).toBe('术语')

    backward.forEach((f) => f())
    expect(state.settings.documents?.find((d) => d.id === 'doc-1')).toEqual(before)
  })

  it('文档目标不经实体别名表重写：别名与既有文档 id 撞名时仍按文档执行（PR #86 评审）', () => {
    const { state, ops } = mkOps([], settingsWithDocs())
    const { forward } = simulateBatch(
      [
        // 先登记一个与既有文档 id 同名的实体 ref 别名（校验侧别名冲突只查
        // 角色/地点桶，不查文档——文档命名空间与实体命名空间独立）
        { op: 'upsert_character', entityId: 'ch-1', ref: 'doc-1', fields: { bio: 'x' } },
        { op: 'upsert_document', entityId: 'doc-1', fields: { body: '新全文' } },
      ] as unknown as ValidatedCommand[],
      ops,
      [],
      [],
      state.settings,
    )
    forward.forEach((f) => f())
    // 文档更新必须落到文档 doc-1，而不是被别名解析成实体 id 后静默跳过
    expect(state.settings.documents?.find((d) => d.id === 'doc-1')?.body).toBe('新全文')
    expect(state.settings.documents?.find((d) => d.id === 'doc-2')?.body).toBe('术语')
    // 同批的实体改动照常生效
    expect(state.settings.characters.find((c) => c.id === 'ch-1')?.bio).toBe('x')
  })

  it('relatedIds 整体替换并解析批内 ref；撤销恢复旧数组', () => {
    const { state, ops } = mkOps([], settingsWithDocs())
    const { forward, backward } = simulateBatch(
      [
        {
          op: 'upsert_document',
          entityId: 'doc-1',
          fields: {
            relatedIds: [
              { kind: 'location', id: 'loc-1' },
              { kind: 'character', id: 'ch-1' },
            ],
          },
        },
      ] as unknown as ValidatedCommand[],
      ops,
      [],
      [],
      state.settings,
    )
    forward.forEach((f) => f())
    expect(state.settings.documents?.find((d) => d.id === 'doc-1')?.relatedIds).toEqual([
      { kind: 'location', id: 'loc-1' },
      { kind: 'character', id: 'ch-1' },
    ])
    backward.forEach((f) => f())
    expect(state.settings.documents?.find((d) => d.id === 'doc-1')?.relatedIds).toEqual([])
  })
})

describe('simulateBatch · 文档与节点/实体同一复合命令', () => {
  it('混合批次：一次 simulate 产出全部闭包，整批回滚到起点', () => {
    const { state, ops } = mkOps([sceneNode('s1')], settingsWithDocs())
    const { forward, backward } = simulateBatch(
      [
        {
          op: 'upsert_character',
          ref: 'hero',
          fields: { name: '林晚' },
        },
        {
          op: 'upsert_document',
          fields: { title: '小传', relatedIds: [{ kind: 'character', id: 'hero' }] },
        },
      ] as unknown as ValidatedCommand[],
      ops,
      state.nodes,
      state.edges,
      state.settings,
    )
    const snapshot = { settings: state.settings }
    forward.forEach((f) => f())
    expect(state.settings.documents).toHaveLength(3)
    expect(state.settings.characters).toHaveLength(2)
    backward.forEach((f) => f())
    expect(state.settings.documents).toEqual(snapshot.settings.documents)
    expect(state.settings.characters).toEqual(snapshot.settings.characters)
  })
})
