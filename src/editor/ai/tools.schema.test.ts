/** #75：复用已配置 ESLint 的 JSON Schema 验证器检查供应商参数契约，不自行实现验证器。 */
import { Linter, type Rule } from 'eslint'
import { describe, expect, it } from 'vitest'
import { AI_TOOLS, toolCallsToCommands } from './tools'
import { validateAiBatch } from './commands'
import { snap } from './testGraphs'
import { SYSTEM_PROMPT } from '../panels/aiThreadModel'

/** 将真实工具参数作为 ESLint 规则选项 schema 编译；非法负载必须被契约拒绝。 */
function check(name: string, payload: object) {
  const parameters = AI_TOOLS.find((tool) => tool.function.name === name)!.function.parameters
  const rule: Rule.RuleModule = { meta: { schema: [parameters] }, create: () => ({}) }
  return new Linter().verify('', [{ plugins: { contract: { rules: { payload: rule } } },
    rules: { 'contract/payload': ['error', payload] } }])
}

describe('batch 命令逐项参数契约', () => {
  it.each([
    { op: 'fly_to_moon' },
    { op: 'create_node' },
    { op: 'create_node', nodeType: 'dialogue', data: { lines: [{}] } },
    { op: 'create_node', nodeType: 'dialogue', data: { lines: [{ text: '你好', speaker: { name: '店长' } }] } },
    { op: 'create_node', nodeType: 'dialogue', data: { lines: [{ kind: 'action', text: '关门', speaker: 'hero' }] } },
    { op: 'create_node', nodeType: 'beat', data: { synopsis: '非节拍字段' } },
    { op: 'create_node', nodeType: 'branch', data: { options: [42] } },
    { op: 'create_node', nodeType: 'shot', data: { refs: [{ kind: 'character', assetId: 'a', label: '两者互斥' }] } },
    { op: 'create_node', nodeType: 'scene', data: { characterIds: [42] } },
    { op: 'update_node', nodeId: 'n1' },
    { op: 'delete_node' },
    { op: 'connect_edge', sourceId: 'n1' },
    { op: 'connect_edge', sourceId: 'n1', targetId: 'n2', edgeKind: 'unknown' },
    { op: 'disconnect_edge', targetId: 'n2' },
    { op: 'upsert_character', fields: {} },
    { op: 'upsert_location', fields: { name: '店', unsupported: '非法字段' } },
  ])('供应商 schema 拒绝不完整或异型命令：%j', (command) => {
    expect(() => check('batch', { commands: [command] })).toThrow()
  })

  it('空批次不符合交付契约', () => {
    expect(() => check('batch', { commands: [] })).toThrow()
  })

  it('系统提示中的完整 JSON 批次示例均满足实际工具 schema', () => {
    const batches = [...SYSTEM_PROMPT.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map((match) => JSON.parse(match[1]) as object)
    expect(batches.length).toBeGreaterThan(0)
    for (const batch of batches) expect(check('batch', batch)).toEqual([])
  })

  it('真实角色→对白→连线批次同时满足供应商 schema 和应用校验', () => {
    const batch = { commands: [
      { op: 'upsert_character', ref: 'manager', fields: { name: '连锁店长', bio: '负责收购' } },
      { op: 'create_node', nodeType: 'dialogue', ref: 'talk', data: { name: '收购交锋', lines: [
        { kind: 'line', speaker: 'manager', text: '我们想谈谈收购。', side: 'left', vo: false },
        { kind: 'action', text: '店长递出合同。' },
      ] } },
      { op: 'connect_edge', sourceId: 'n1', targetId: 'talk', edgeKind: 'sequence' },
    ] }
    expect(check('batch', batch)).toEqual([])
    const parsed = toolCallsToCommands([{ id: 'b', type: 'function', function: {
      name: 'batch', arguments: JSON.stringify(batch),
    } }])
    expect(validateAiBatch(parsed.commands, { ...snap(), settings: { characters: [], locations: [] } }).ok).toBe(true)
  })
})

describe('单工具同样提供完整字段结构', () => {
  it.each([
    ['create_node', { nodeType: 'unsupported' }],
    ['create_node', { nodeType: 'scene', data: { sceneNo: 0 } }],
    ['create_node', { nodeType: 'dialogue', data: { lines: [{ text: 42 }] } }],
    ['update_node_spec', { nodeId: 'n1', patch: { characterIds: [false] } }],
    ['upsert_character', { fields: { name: false } }],
    ['upsert_location', { fields: { bio: '角色字段' } }],
  ])('%s 拒绝错误字段形状', (name, payload) => {
    expect(() => check(name as string, payload as object)).toThrow()
  })

  it.each([
    ['create_node', { nodeType: 'scene' }],
    ['create_node', { nodeType: 'dialogue', data: { lines: [{ text: '无名角色的台词' }] } }],
    ['create_node', { nodeType: 'branch', data: { options: ['走', { label: '留' }] } }],
    ['update_node_spec', { nodeId: 'n1', patch: { synopsis: '新的梗概' } }],
    ['upsert_character', { entityId: 'existing', fields: { bio: '只更新小传' } }],
  ])('%s 保留默认字段和既有简写输入', (name, payload) => {
    expect(check(name as string, payload as object)).toEqual([])
  })
})
