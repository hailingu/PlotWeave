import type { AiCommand } from './commands'

/**
 * Agent 工具表（数据模型 §12.2：工具集 = 命令清单的封装）。
 * 读工具由前端就地执行回喂；写工具调用映射为 AiCommand——
 * 仍走「整批预览 → 用户确认 → 复合命令入栈」通道，绝不自动执行。
 */

export interface ToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

const str = (description: string) => ({ type: 'string', description })
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

/** 模型可调用的全部工具（读二 + 写六，含 batch）。 */
export const AI_TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'get_graph_snapshot',
      description: '读取画布快照：节点 id/类型/标签/参数、连线语义、剧情流顺序与设定集 id',
      parameters: obj({}),
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_node',
      description: '读取单个节点的完整字段（id/type/data）',
      parameters: obj({ nodeId: str('节点 id') }, ['nodeId']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_node',
      description: '新建节点；data 只写要定制的字段，其余用默认；ref 供后续命令引用新节点',
      parameters: obj(
        {
          nodeType: { type: 'string', description: 'scene|beat|dialogue|branch|shot' },
          ref: { type: 'string', description: '临时别名，供本批后续命令引用' },
          data: { type: 'object', description: '字段补丁（键见节点字段表）' },
          reason: str('改动理由'),
        },
        ['nodeType'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_node',
      description: '删除节点及其全部连线（撤销可回滚，但预览卡中会标红置顶）',
      parameters: obj({ nodeId: str('节点 id 或 ref'), reason: str('改动理由') }, ['nodeId']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_node_spec',
      description: '修改节点字段（只写要改的字段）',
      parameters: obj(
        {
          nodeId: str('节点 id 或 ref'),
          patch: { type: 'object', description: '字段补丁（键见节点字段表）' },
          reason: str('改动理由'),
        },
        ['nodeId', 'patch'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'connect_edge',
      description: '建连线：缺省剧情流；branch 需 optionIndex（0 基）；attach 仅 场景→分镜卡',
      parameters: obj(
        {
          sourceId: str('起点节点 id 或 ref'),
          targetId: str('终点节点 id 或 ref'),
          edgeKind: { type: 'string', description: 'sequence（缺省）| branch | attach' },
          optionIndex: { type: 'integer', description: 'edgeKind=branch 时的选项下标' },
          reason: str('改动理由'),
        },
        ['sourceId', 'targetId'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'disconnect_edge',
      description: '删除两节点间的连线',
      parameters: obj(
        { sourceId: str('起点节点 id'), targetId: str('终点节点 id'), reason: str('改动理由') },
        ['sourceId', 'targetId'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'batch',
      description:
        '把一次改动的全部命令放进同一个批次（推荐：用户只确认一次）。' +
        'commands 元素形如 {"op":"…",…}，op 只能取：' +
        'create_node / update_node / delete_node / connect_edge / disconnect_edge' +
        '（注意是 update_node，不是 update_node_spec），其余字段与上述写工具参数一致',
      parameters: obj(
        {
          commands: {
            type: 'array',
            description:
              '命令数组：{"op":"create_node","nodeType":"…","ref":"…","data":{…}} | ' +
              '{"op":"update_node","nodeId":"…","patch":{…}} | ' +
              '{"op":"delete_node","nodeId":"…"} | ' +
              '{"op":"connect_edge","sourceId":"…","targetId":"…"} | ' +
              '{"op":"disconnect_edge","sourceId":"…","targetId":"…"}',
            items: { type: 'object' },
          },
        },
        ['commands'],
      ),
    },
  },
]

export const READ_TOOL_NAMES = new Set(['get_graph_snapshot', 'get_node'])
export const WRITE_TOOL_NAMES = new Set([
  'create_node',
  'delete_node',
  'update_node_spec',
  'connect_edge',
  'disconnect_edge',
  'batch',
])

export interface ReadRequest {
  /** tool_call id，回喂 role:'tool' 消息时透传。 */
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ToolCallParse {
  commands: AiCommand[]
  readRequests: ReadRequest[]
  /** 解析失败的工具调用（坏 JSON / 未知工具名），文案面向用户。 */
  errors: string[]
}

/** 解析一次 assistant 回复里的 tool_calls：读工具收集、写工具映射为命令。 */
export function toolCallsToCommands(calls: ToolCall[]): ToolCallParse {
  const commands: AiCommand[] = []
  const readRequests: ReadRequest[] = []
  const errors: string[] = []

  for (const c of calls) {
    const { name } = c.function
    let args: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(c.function.arguments || '{}')
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not an object')
      }
      args = parsed as Record<string, unknown>
    } catch {
      errors.push(`工具调用 ${c.id}（${name}）：参数不是有效对象`)
      continue
    }

    if (READ_TOOL_NAMES.has(name)) {
      readRequests.push({ id: c.id, name, args })
      continue
    }
    if (!WRITE_TOOL_NAMES.has(name)) {
      errors.push(`未知工具：${name}（${c.id}）`)
      continue
    }

    if (name === 'create_node') {
      commands.push({
        op: 'create_node',
        nodeType: String(args.nodeType ?? ''),
        ref: args.ref,
        data: args.data,
        reason: args.reason,
      })
    } else if (name === 'update_node_spec') {
      commands.push({
        op: 'update_node',
        nodeId: String(args.nodeId ?? ''),
        patch: (typeof args.patch === 'object' && args.patch !== null && !Array.isArray(args.patch)
          ? args.patch
          : {}) as Record<string, unknown>,
        reason: args.reason,
      })
    } else if (name === 'delete_node') {
      commands.push({ op: 'delete_node', nodeId: String(args.nodeId ?? ''), reason: args.reason })
    } else if (name === 'connect_edge') {
      commands.push({
        op: 'connect_edge',
        sourceId: String(args.sourceId ?? ''),
        targetId: String(args.targetId ?? ''),
        edgeKind: args.edgeKind,
        optionIndex: args.optionIndex,
        reason: args.reason,
      })
    } else if (name === 'disconnect_edge') {
      commands.push({
        op: 'disconnect_edge',
        sourceId: String(args.sourceId ?? ''),
        targetId: String(args.targetId ?? ''),
        reason: args.reason,
      })
    } else {
      // batch：commands 数组并入，形状由下游校验器把关；
      // 模型常把工具名当 op 写进批次（update_node_spec）——在此归一为命令词表
      const inner = args.commands
      if (Array.isArray(inner)) {
        commands.push(
          ...inner.map((cmd) => {
            if (
              typeof cmd === 'object' &&
              cmd !== null &&
              !Array.isArray(cmd) &&
              (cmd as { op?: unknown }).op === 'update_node_spec'
            ) {
              return { ...(cmd as Record<string, unknown>), op: 'update_node' } as AiCommand
            }
            return cmd as AiCommand
          }),
        )
      } else errors.push(`batch 工具（${c.id}）：commands 不是数组`)
    }
  }

  return { commands, readRequests, errors }
}
