import { describe, expect, it } from 'vitest'
import { AI_TOOLS, WRITE_TOOL_NAMES, toolCallsToCommands, type ToolCall } from './tools'

const call = (name: string, args: unknown): ToolCall => ({
  id: `call-${name}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
})

describe('toolCallsToCommands（§12.2 tool_calls → 预览卡命令）', () => {
  it('五个写工具映射为对应命令；reason 透传', () => {
    const { commands, errors } = toolCallsToCommands([
      call('create_node', { nodeType: 'scene', ref: 'a', data: { name: '天台' } }),
      call('update_node_spec', { nodeId: 'a', patch: { time: '🌙 夜' }, reason: '夜戏' }),
      call('delete_node', { nodeId: 'x' }),
      call('connect_edge', { sourceId: 'a', targetId: 'b', edgeKind: 'branch', optionIndex: 1 }),
      call('disconnect_edge', { sourceId: 'b', targetId: 'c' }),
    ])
    expect(errors).toEqual([])
    expect(commands.map((c) => c.op)).toEqual([
      'create_node',
      'update_node',
      'delete_node',
      'connect_edge',
      'disconnect_edge',
    ])
    expect(commands[0]).toMatchObject({ nodeType: 'scene', ref: 'a' })
    expect(commands[1]).toMatchObject({ reason: '夜戏' })
    expect(commands[3]).toMatchObject({ edgeKind: 'branch', optionIndex: 1 })
  })

  it('batch 工具的 commands 原样并入（保持顺序）', () => {
    const inner = [
      { op: 'create_node', nodeType: 'beat', ref: 'b' },
      { op: 'connect_edge', sourceId: 'b', targetId: 's1' },
    ]
    const { commands, errors } = toolCallsToCommands([call('batch', { commands: inner })])
    expect(errors).toEqual([])
    expect(commands).toEqual(inner)
  })

  it('读工具进入 readRequests，不产生命令', () => {
    const { commands, readRequests } = toolCallsToCommands([
      call('get_graph_snapshot', {}),
      call('get_node', { nodeId: 'n1' }),
    ])
    expect(commands).toEqual([])
    expect(readRequests.map((r) => r.name)).toEqual(['get_graph_snapshot', 'get_node'])
    expect(readRequests[1].args).toEqual({ nodeId: 'n1' })
    expect(readRequests[0].id).toBe('call-get_graph_snapshot')
  })

  it('坏参数与未知工具进 errors，不中断其余解析', () => {
    const bad: ToolCall = {
      id: 'call-bad',
      type: 'function',
      function: { name: 'create_node', arguments: '{not-json' },
    }
    const { commands, errors } = toolCallsToCommands([
      bad,
      call('fly_to_moon', {}),
      call('delete_node', { nodeId: 'keep' }),
    ])
    expect(commands).toEqual([{ op: 'delete_node', nodeId: 'keep' }])
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('call-bad')
  })
})

describe('工具表定义', () => {
  it('包含数据模型 §12.2 的读三写五工具，参数均为对象 schema', () => {
    const names = AI_TOOLS.map((t) => t.function.name)
    for (const expected of [
      'get_graph_snapshot',
      'get_node',
      'create_node',
      'delete_node',
      'update_node_spec',
      'connect_edge',
      'disconnect_edge',
      'batch',
    ]) {
      expect(names).toContain(expected)
    }
    for (const t of AI_TOOLS) {
      expect(t.type).toBe('function')
      expect(t.function.parameters.type).toBe('object')
    }
    expect(WRITE_TOOL_NAMES.has('batch')).toBe(true)
    expect(WRITE_TOOL_NAMES.has('get_node')).toBe(false)
  })
})
