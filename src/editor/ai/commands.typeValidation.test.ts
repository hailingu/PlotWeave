/**
 * issue 49：类型字符串命中 Object.prototype 属性时仍须整批拒绝。
 * 覆盖 create/edge、共享载荷检查与 update 入口；接受继承键或重新引入
 * 未检查的白名单查表，会导致抛错、非法命令放行或原子性断言失败。
 */
import { describe, expect, it } from 'vitest'
import { validateAiBatch, type AiGraphSnapshot, type BatchValidation } from './commands'
import { payloadIssue } from './payloadCheck'
import { richSnap, snap } from './testGraphs'

const prototypeTypes = Object.getOwnPropertyNames(Object.prototype)
const createCases = prototypeTypes.flatMap((nodeType) => [
  { nodeType, shape: '缺省', data: undefined },
  { nodeType, shape: '空对象', data: {} },
  { nodeType, shape: '非空对象', data: { name: 'x' } },
])

/** 两个无连线节点，排除重复/成环约束对类型检查的干扰。 */
function graph(): AiGraphSnapshot {
  return { ...snap(), edges: [], settings: { characters: [], locations: [] } }
}

/** 拒绝必须保留对应命令的可读诊断，并禁止交付任何执行命令。 */
function expectRejected(result: BatchValidation, message: string, index = 0): void {
  expect(result.ok).toBe(false)
  expect(result.commands).toEqual([])
  expect(result.issues).toContainEqual({ index, message: expect.stringContaining(message) })
}

describe('issue 49 · 创建与连线类型只接受协议成员', () => {
  it.each(createCases)('create $nodeType，data $shape：以未知类型拒绝', ({ nodeType, data }) => {
    const result = validateAiBatch([{ op: 'create_node', nodeType, data }], graph())
    expectRejected(result, '未知节点类型')
    expect(result.items).toEqual([])
  })

  it.each(prototypeTypes)('connect %s：以未知类型拒绝', (edgeKind) => {
    const result = validateAiBatch([
      { op: 'connect_edge', sourceId: 'n1', targetId: 'n2', edgeKind },
    ], graph())
    expectRejected(result, '未知连线类型')
    expect(result.items).toEqual([])
  })

  it('去空白后的原型键仍非法，普通未知类型也继续拒绝', () => {
    const result = validateAiBatch([
      { op: 'create_node', nodeType: ' toString ', data: {} },
      { op: 'create_node', nodeType: 'dragon', data: {} },
      { op: 'connect_edge', sourceId: 'n1', targetId: 'n2', edgeKind: ' constructor ' },
      { op: 'connect_edge', sourceId: 'n1', targetId: 'n2', edgeKind: 'x' },
    ], graph())
    expectRejected(result, '未知节点类型', 0)
    expectRejected(result, '未知节点类型', 1)
    expectRejected(result, '未知连线类型', 2)
    expectRejected(result, '未知连线类型', 3)
  })
})

describe('issue 49 · 共享载荷与修改入口拒绝未知目标类型', () => {
  it.each(prototypeTypes)('payload %s：空/非空载荷均不得把继承属性当白名单', (nodeType) => {
    for (const fields of [{}, { name: 'x' }]) {
      const issue = payloadIssue(nodeType, fields, new Map())
      expect(issue).toContain(nodeType)
      expect(issue).toContain('暂不支持 AI 命令修改')
      expect(issue).not.toContain('[native code]')
      expect(issue).not.toContain('[object Object]')
    }
  })

  it.each(prototypeTypes)('update %s 快照目标：结构化拒绝且不改快照', (type) => {
    const snapshot = graph()
    snapshot.nodes[0].type = type
    const before = structuredClone(snapshot)
    const result = validateAiBatch([
      { op: 'update_node', nodeId: 'n1', patch: { name: 'x' } },
    ], snapshot)
    expectRejected(result, '暂不支持 AI 命令修改')
    expect(snapshot).toEqual(before)
  })
})

describe('issue 49 · 批次原子性与纠正后恢复', () => {
  it('混合批次一次收集类型错误，纠正后按原始顺序交付合法命令', () => {
    const snapshot = graph()
    const before = structuredClone(snapshot)
    const rejected = validateAiBatch([
      { op: 'update_node', nodeId: 'n1', patch: { name: '已修改' } },
      { op: 'create_node', nodeType: 'toString', ref: 'new', data: { name: '新节拍' } },
      { op: 'connect_edge', sourceId: 'n1', targetId: 'new', edgeKind: 'constructor' },
    ], snapshot)
    expectRejected(rejected, '未知节点类型', 1)
    expectRejected(rejected, '未知连线类型', 2)
    expect(rejected.items).toEqual([])
    expect(snapshot).toEqual(before)

    const corrected = validateAiBatch([
      { op: 'update_node', nodeId: 'n1', patch: { name: '已修改' } },
      { op: 'create_node', nodeType: 'beat', ref: 'new', data: { name: '新节拍' } },
      { op: 'connect_edge', sourceId: 'n1', targetId: 'new', edgeKind: 'sequence' },
    ], snapshot)
    expect(corrected.ok).toBe(true)
    expect(corrected.issues).toEqual([])
    expect(corrected.commands.map((cmd) => cmd.op)).toEqual(['update_node', 'create_node', 'connect_edge'])
    expect(snapshot).toEqual(before)
  })

  it.each(['scene', 'beat', 'dialogue', 'branch', 'shot'])('合法 %s 创建与批内 ref 修改仍通过', (nodeType) => {
    const data = nodeType === 'branch' || nodeType === 'shot' ? { prompt: 'x' } : { name: 'x' }
    const result = validateAiBatch([
      { op: 'create_node', nodeType, ref: 'new', data },
      { op: 'update_node', nodeId: 'new', patch: data },
    ], graph())
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.commands[0]).toMatchObject({ op: 'create_node', nodeType, data })
    expect(result.commands[1]).toMatchObject({ op: 'update_node', patch: { nodeType, patch: data } })
  })

  it.each([
    { edgeKind: undefined, sourceId: 's1', targetId: 'b1', expected: 'sequence' },
    { edgeKind: 'sequence', sourceId: 's1', targetId: 'b1', expected: 'sequence' },
    { edgeKind: 'branch', sourceId: 'b1', targetId: 's1', expected: 'branch' },
    { edgeKind: 'attach', sourceId: 's1', targetId: 'sh1', expected: 'attach' },
  ])('合法连线 $edgeKind 保持语义', ({ expected, ...edge }) => {
    const result = validateAiBatch([{ op: 'connect_edge', ...edge, optionIndex: 0 }], richSnap())
    expect(result.ok).toBe(true)
    expect(result.commands[0]).toMatchObject({ op: 'connect_edge', edgeKind: expected })
  })
})
