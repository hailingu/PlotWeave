/**
 * 边的句柄规范与隔离测试（§5/§11.1 第 3 步/§11.3）：匿名端口句柄剥离、
 * 节点/边 id 重发与成环/attach 宿主唯一隔离、句柄运行时类型校验、
 * 数值型稳定 id 与越界旧下标句柄的歧义隔离。
 */
import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { parseProject, serializeProject } from './convert'
import type { ProjectDocument } from './document'
import { NOW, mkContent } from './convertFixtures'

describe('边句柄规范（§5：匿名端口句柄必须省略）', () => {
  it('落盘剥离：sequence 边的 sourceHandle 与任意 targetHandle 不进入载荷', () => {
    const content = mkContent()
    content.edges[0] = {
      ...content.edges[0],
      sourceHandle: 'stale-option',
      targetHandle: 't-in',
    } as Edge
    content.edges[2] = { ...content.edges[2], targetHandle: 't-in' } as Edge
    const doc = serializeProject(content, 'p-1', NOW)
    expect(doc.graph.edges[0]).toEqual({
      id: 'e1',
      source: 's1',
      target: 'd1',
      data: { kind: 'sequence' },
    })
    expect(doc.graph.edges[2]).toEqual({
      id: 'e3',
      source: 's1',
      target: 'sh1',
      sourceHandle: 'shots',
      data: { kind: 'attach' },
    })
  })

  it('加载剥离：已知 kind 边携带 targetHandle 不隔离，剥离并警告', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { edges: Record<string, unknown>[] }
    }
    doc.graph.edges[0].targetHandle = 't-in' // sequence
    doc.graph.edges[1].targetHandle = 't-in' // branch
    doc.graph.edges[2].targetHandle = 't-in' // attach
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
    expect(round.content.edges.every((e) => e.targetHandle === undefined)).toBe(true)
    expect(round.warnings.length).toBeGreaterThan(0)
  })

  it('未知/非字符串 kind 的边隔离并警告（§5 判别联合边界，绝不为未知 kind 猜测变体）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push({
      id: 'e-unknown',
      source: 's1',
      target: 'd1',
      data: { kind: 'teleport' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).not.toContain('e-unknown')
    expect(round.warnings.some((w) => w.includes('e-unknown'))).toBe(true)
  })

  it('data.order 异型（非有限数）：确定性剥离并警告，边本身保留不隔离（§5 存在时须为有限数）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { edges: Record<string, unknown>[] }
    }
    ;(doc.graph.edges[0].data as Record<string, unknown>).order = 'first' // 字符串
    ;(doc.graph.edges[1].data as Record<string, unknown>).order = { seq: 1 } // 对象
    ;(doc.graph.edges[2].data as Record<string, unknown>).order = Number.NaN // 非有限
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
    expect(round.content.edges.every((e) => (e.data as { order?: unknown } | undefined)?.order === undefined)).toBe(
      true,
    )
    expect(round.warnings.filter((w) => w.includes('order'))).toHaveLength(3)
  })
})

describe('归一化：§11.1 第 3 步 id 重发 / 成环 / attach 宿主唯一', () => {
  it('重复节点 id：保留文档序首个，后续重发本域未占用新 id（按 id 的引用仍解析到首见节点）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const dup = structuredClone(doc.graph.nodes.find((n) => n.id === 'd1')!)
    doc.graph.nodes.push(dup) // 文档序末尾再放一份 d1
    const round = parseProject(doc)
    const ids = round.content.nodes.map((n) => n.id)
    expect(ids).toHaveLength(6)
    expect(ids.filter((i) => i === 'd1')).toHaveLength(1)
    expect(ids[2]).toBe('d1') // 首见节点保留原 id 与位置
    const reissued = ids[5]
    expect(reissued).not.toBe('d1')
    expect(new Set(ids).size).toBe(6) // 重发 id 不与任何既有 id 碰撞
    // 重发节点内容保留（无连线孤儿，由用户处置）
    const orphan = round.content.nodes[5].data as { name?: string; lines?: unknown[] }
    expect(orphan.name).toBe('对白')
    expect(orphan.lines).toHaveLength(1)
    // 指向 d1 的边仍解析到首见节点，不产生改接
    expect(round.content.edges.map((e) => e.id)).toContain('e1')
    expect(round.warnings.some((w) => w.includes('重复') && w.includes('d1'))).toBe(true)
  })

  it('自环边（source === target）隔离并警告', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push({
      id: 'e-self',
      source: 'b1',
      target: 'b1',
      data: { kind: 'sequence' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).not.toContain('e-self')
    expect(round.warnings.some((w) => w.includes('e-self') && w.includes('自环'))).toBe(true)
  })

  it('成环边：按文档序重建剧情流图，加入即闭合回路的 sequence 边隔离', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push({
      id: 'e-back',
      source: 'd1',
      target: 's1', // 与既有 e1（s1→d1）闭合回路
      data: { kind: 'sequence' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    const round = parseProject(doc)
    const edgeIds = round.content.edges.map((e) => e.id)
    expect(edgeIds).toContain('e1') // 文档序首条保留
    expect(edgeIds).not.toContain('e-back')
    expect(round.warnings.some((w) => w.includes('e-back') && w.includes('环'))).toBe(true)
  })

  it('成环边：branch 边同样参与环检测（传递闭包）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    // 既有 e2 = br1→d1（option-opt-2）；再加 d1→br1 即闭合 br1→d1→br1
    doc.graph.edges.push({
      id: 'e-cycle',
      source: 'd1',
      target: 'br1',
      data: { kind: 'sequence' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    const round = parseProject(doc)
    const edgeIds = round.content.edges.map((e) => e.id)
    expect(edgeIds).toContain('e2')
    expect(edgeIds).not.toContain('e-cycle')
    expect(round.warnings.some((w) => w.includes('e-cycle') && w.includes('环'))).toBe(true)
  })

  it('attach 边不参与环检测：scene↔shot 垂直从属照常保留', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).toContain('e3')
  })

  it('同一 shot 的多条入向 attach 边：保留文档序首条，其余按孤儿边隔离并警告', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const secondScene = structuredClone(doc.graph.nodes.find((n) => n.id === 's1')!)
    secondScene.id = 's2'
    doc.graph.nodes.push(secondScene)
    doc.graph.edges.push({
      id: 'e-attach2',
      source: 's2',
      target: 'sh1', // sh1 已有 e3（s1→sh1）宿主
      sourceHandle: 'shots',
      data: { kind: 'attach' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    const round = parseProject(doc)
    const edgeIds = round.content.edges.map((e) => e.id)
    expect(edgeIds).toContain('e3') // 文档序首条保留
    expect(edgeIds).not.toContain('e-attach2')
    expect(round.warnings.some((w) => w.includes('e-attach2') && w.includes('宿主'))).toBe(true)
  })

  it('sequence 边 source 为 branch 节点：按孤儿边隔离并警告（§5 端口归属反向约束）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push({
      id: 'e-seq-from-branch',
      source: 'br1', // branch 无匿名输出端口，不能引出 sequence 边
      target: 'd1',
      data: { kind: 'sequence' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).not.toContain('e-seq-from-branch')
    expect(round.warnings.some((w) => w.includes('e-seq-from-branch'))).toBe(true)
    // branch 经选项端口引出的 branch 边不受影响
    expect(round.content.edges.map((e) => e.id)).toContain('e2')
  })

  it('同 source/target/sourceHandle 的逻辑重复边：保留文档序首条，其余隔离并警告（§11.3）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push(
      { id: 'e-dup-seq', source: 's1', target: 'd1', data: { kind: 'sequence' } },
      { id: 'e-dup-opt', source: 'br1', target: 'd1', sourceHandle: 'option-opt-2', data: { kind: 'branch' } },
    ) as unknown as ProjectDocument['graph']['edges'][number][]
    const round = parseProject(doc)
    const edgeIds = round.content.edges.map((e) => e.id)
    expect(edgeIds).toContain('e1') // 文档序首条 sequence 保留
    expect(edgeIds).toContain('e2') // 文档序首条 branch（option-opt-2）保留
    expect(edgeIds).not.toContain('e-dup-seq')
    expect(edgeIds).not.toContain('e-dup-opt')
    expect(round.warnings.some((w) => w.includes('e-dup-seq') && w.includes('重复'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('e-dup-opt') && w.includes('重复'))).toBe(true)
  })

  it('重复边 id：保留文档序首条原 id，后续同 id 边重发新 id 并警告（§11.1 第 3 步）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push({
      id: 'e1', // 与首条 sequence 边撞 id，但端点不同（非逻辑重复）
      source: 'b1',
      target: 'd1',
      data: { kind: 'sequence' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    const round = parseProject(doc)
    const withE1 = round.content.edges.filter((e) => e.id === 'e1')
    expect(withE1).toHaveLength(1)
    expect(withE1[0].source).toBe('s1') // 文档序首条保留原 id
    // 后续同 id 边以新 id 存活：React Flow 身份唯一，选中/删除不再歧义
    const reissued = round.content.edges.find((e) => e.source === 'b1')!
    expect(reissued.id).not.toBe('e1')
    expect(round.warnings.some((w) => w.includes('重复') && w.includes('e1'))).toBe(true)
  })

  it('空白边 id：非空串同款按 §8.1 trim 口径重发新 id 并警告', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push({
      id: '   ', // 真值非空但 trim 后为空：React Flow 身份（选中/删除/撤销）不可靠
      source: 'b1',
      target: 'd1',
      data: { kind: 'sequence' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    const round = parseProject(doc)
    const reissued = round.content.edges.find((e) => e.source === 'b1' && e.target === 'd1')!
    expect(reissued.id).toMatch(/^edge-/)
    expect(round.warnings.some((w) => w.includes('边 id 缺失或非法'))).toBe(true)
  })

  it('v1 可修复脏数据 repaired=true（回写依据）——修复不得只留内存、每次打开重造"稳定" id', () => {
    // 空白边 id（就地重发）与标题去空白（值改写）两类修复都要能被察觉：
    // normalizeDocument 就地改写传入对象，比较必须对原始克隆进行
    const dirty = serializeProject(mkContent(), 'p-1', NOW)
    dirty.graph.edges.push({
      id: '   ',
      source: 'b1',
      target: 'd1',
      data: { kind: 'sequence' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    dirty.episodeTitles = { 1: ' 开局 ' }
    expect(parseProject(dirty).repaired).toBe(true)

    // 只读警告（悬空引用标记，§11.4）不改写内容：不触发回写
    const danglingOnly = serializeProject(mkContent(), 'p-1', NOW)
    danglingOnly.graph.nodes.push({
      id: 'ghost-ref',
      type: 'scene',
      layout: { position: { x: 0, y: 0 } },
      ui: { selected: false, expanded: true },
      data: { spec: { characterIds: ['ch-none'], interior: true, sceneNo: 9, synopsis: '', time: '' }, meta: { label: '悬空' } },
    } as unknown as ProjectDocument['graph']['nodes'][number])
    const round = parseProject(danglingOnly)
    expect(round.warnings.some((w) => w.includes('ch-none'))).toBe(true)
    expect(round.repaired).toBe(false)
  })
})

describe('归一化：边句柄的运行时类型校验（§11.1，JSON 边界类型擦除）', () => {
  /** 可改写的脏 v1 文档视图（仅边数组）。 */
  type EdgeDoc = { graph: { edges: Record<string, unknown>[] } }

  it('branch 边 sourceHandle 非字符串：隔离该边并警告，其余边保留、项目照常打开', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as EdgeDoc
    doc.graph.edges.find((e) => e.id === 'e2')!.sourceHandle = 42
    const round = parseProject(doc)
    expect(round.content.edges.find((e) => e.id === 'e2')).toBeUndefined()
    expect(round.warnings.some((w) => w.includes('e2') && w.includes('sourceHandle'))).toBe(true)
    expect(round.content.edges.map((e) => e.id)).toEqual(['e1', 'e3'])
  })

  it('attach 边 sourceHandle 为对象：隔离该边并警告，不触发 startsWith 类型异常', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as EdgeDoc
    doc.graph.edges.find((e) => e.id === 'e3')!.sourceHandle = { handle: 'shots' }
    const round = parseProject(doc)
    expect(round.content.edges.find((e) => e.id === 'e3')).toBeUndefined()
    expect(round.warnings.some((w) => w.includes('e3') && w.includes('sourceHandle'))).toBe(true)
    expect(round.content.edges.map((e) => e.id)).toEqual(['e1', 'e2'])
  })
})

describe('归一化：数值型稳定 id 与越界旧下标句柄的歧义隔离（§11.1 迁移链 ②）', () => {
  it('选项稳定 id 为数字串时，越界的 option-N 旧句柄不得被解释为该稳定 id', () => {
    const v0 = {
      schemaVersion: 0,
      project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z' },
      graph: {
        nodes: [
          {
            id: 'br1', type: 'branch', position: { x: 0, y: 0 },
            data: { prompt: '去哪', options: [{ id: '9', label: 'A' }] },
          },
          { id: 's1', type: 'scene', position: { x: 0, y: 0 }, data: { name: '场一', sceneNo: 1, interior: true, synopsis: '' } },
        ],
        edges: [
          // 旧下标 9 越界（仅下标 0 存在）：不得碰巧解析为稳定 id "9" 而接给 A
          { id: 'e-bad', source: 'br1', target: 's1', sourceHandle: 'option-9', type: 'branch', data: { optionLabel: '越界' } },
          // 下标 0 正常改写到稳定 id "9"
          { id: 'e-ok', source: 'br1', target: 's1', sourceHandle: 'option-0', type: 'branch', data: { optionLabel: 'A' } },
        ],
      },
      settings: { characters: [], locations: [] },
      episodeTitles: {},
      assets: { byId: {} },
    }
    const round = parseProject(v0)
    const ids = round.content.edges.map((e) => e.id)
    expect(ids).toContain('e-ok')
    expect(ids).not.toContain('e-bad')
    expect(round.warnings.some((w) => w.includes('e-bad'))).toBe(true)
    // e-ok 确实指向选项 9（label A）
    const eOk = round.content.edges.find((e) => e.id === 'e-ok')!
    expect(eOk.sourceHandle).toBe('option-9')
  })
})

