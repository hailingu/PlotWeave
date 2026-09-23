import type { AiCommand } from './commands'
import { BATCH_PARAMETERS, WRITE_PARAMETERS } from './toolSchemas'

/**
 * Agent 工具表（数据模型 §12.2：工具集 = 命令清单的封装）。
 * 读工具由前端就地执行回喂；写工具调用映射为 AiCommand——
 * 仍走「整批预览 → 用户确认 → 复合命令入栈」通道，绝不自动执行。
 * issue 44 起含设定实体通道：get_settings_snapshot 读 + upsert_character /
 * upsert_location 写；issue 56 起含设定文档通道：get_document 读 +
 * upsert_document 写（字段协议单一真相在 entityFields.ts）。
 */

export interface ToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** OpenAI 兼容 tool_call 的最小形状（arguments 为未解析的 JSON 字符串，
 * 解析与分流见 toolCallsToCommands）。 */
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
      description:
        '读取画布快照：节点 id/类型/标签/参数、连线语义、剧情流顺序与设定集 id',
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
      name: 'find_nodes',
      description:
        '按 id/名称/提示词/选项/台词检索全部节点（含画布摘要因体积预算未列出的条目），' +
        '命中条目附其关联连线；摘要被节选后按用户提到的名称定位目标或查连线用此工具。' +
        '结果分页：多命中按节点翻页、单节点命中按该节点连线翻页，截断标记给出下一页 offset；' +
        '查询串恰为某节点 id 时直接进入该节点的连线分页视图（不受 id 子串碰撞影响）；' +
        '查询串形如 "id:<前缀>#<序号>~<ID指纹>" 时按原始 ID 定位候选并分段返回完整 id' +
        '（offset=段号，按序拼接；画布增删后仍定位原节点或明确失效）；旧的无指纹序号句柄不再接受。' +
        '无 # 后缀时按唯一前缀匹配；超长 id 的连线续页使用 "node:<前缀>#<序号>~<ID指纹>" 句柄',
      parameters: obj(
        {
          query: str('检索关键词（节点名称/文案/id 片段）'),
          offset: {
            type: 'integer',
            minimum: 0,
            description:
              '分页偏移（多命中=节点序，单命中=该节点连线序；默认 0）',
          },
        },
        ['query'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_settings_snapshot',
      description:
        '读取设定集清单：全部角色/地点的 id、名称与小传/备注，文档只列 id 与标题' +
        '（props 只读不可写）。写 characterIds/locationId/speaker 或修改实体前先读取以复用已有实体',
      parameters: obj({}),
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_document',
      description:
        '读取单个设定文档的完整内容（id/title/body/relatedIds）；写或续写文档前先读取',
      parameters: obj(
        {
          documentId: str(
            '文档 id（来自 get_settings_snapshot 的 documents 清单）',
          ),
        },
        ['documentId'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_node',
      description:
        '新建节点；data 只写要定制的字段，其余用默认；ref 供后续命令引用新节点',
      parameters: WRITE_PARAMETERS.create_node,
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_node',
      description: '删除节点及其全部连线（撤销可回滚，但预览卡中会标红置顶）',
      parameters: WRITE_PARAMETERS.delete_node,
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_node_spec',
      description: '修改节点字段（只写要改的字段）',
      parameters: WRITE_PARAMETERS.update_node_spec,
    },
  },
  {
    type: 'function',
    function: {
      name: 'connect_edge',
      description:
        '建连线：缺省剧情流；branch 需 optionIndex（0 基）；attach 仅 场景→分镜卡',
      parameters: WRITE_PARAMETERS.connect_edge,
    },
  },
  {
    type: 'function',
    function: {
      name: 'disconnect_edge',
      description: '删除两节点间的连线',
      parameters: WRITE_PARAMETERS.disconnect_edge,
    },
  },
  {
    type: 'function',
    function: {
      name: 'upsert_character',
      description:
        '新建或修改角色实体（issue 44）：新建不带 entityId（fields.name 必填，可带 ref ' +
        '供本批后续命令在 scene.characterIds / lines[].speaker 引用）；修改必须带 entityId' +
        '（设定集快照里的精确 id，不要按名字猜），fields 只写要改的字段，未提及字段保持不变；' +
        '不支持删除或合并实体',
      parameters: WRITE_PARAMETERS.upsert_character,
    },
  },
  {
    type: 'function',
    function: {
      name: 'upsert_location',
      description:
        '新建或修改地点实体：新建不带 entityId（fields.name 必填，可带 ref 供本批 ' +
        'scene.locationId 引用）；修改必须带 entityId（精确 id，不要按名字猜），' +
        'fields 只写要改的字段，未提及字段保持不变',
      parameters: WRITE_PARAMETERS.upsert_location,
    },
  },
  {
    type: 'function',
    function: {
      name: 'upsert_document',
      description:
        '新建或修改设定文档（人物小传/世界观/术语表等长篇文本，issue 56）：' +
        '新建不带 entityId（fields.title 必填）；修改必须带 entityId（精确 id，' +
        '先 get_document 读取全文再改写），fields 只写要改的字段，未提及字段保持不变。' +
        'relatedIds 关联角色/地点：[{kind, id}]，id 用设定集快照里的实体 id 或本批实体 ref；' +
        '不支持删除文档',
      parameters: WRITE_PARAMETERS.upsert_document,
    },
  },
  {
    type: 'function',
    function: {
      name: 'batch',
      description:
        '把一次改动的全部命令放进同一个批次（推荐：用户只确认一次）。' +
        'commands 元素形如 {"op":"…",…}，op 只能取：' +
        'create_node / update_node / delete_node / connect_edge / disconnect_edge / ' +
        'upsert_character / upsert_location / upsert_document' +
        '（注意是 update_node，不是 update_node_spec），其余字段与上述写工具参数一致。' +
        '同批可先 upsert 实体再绑定：创建实体的 ref 可直接写进 scene.characterIds / ' +
        'scene.locationId / lines[].speaker / 文档 relatedIds，应用解析为真实 id 后落地',
      parameters: BATCH_PARAMETERS,
    },
  },
]

/** 读工具名集合：就地执行回喂（不进预览/命令通道）。 */
export const READ_TOOL_NAMES = new Set([
  'get_graph_snapshot',
  'get_node',
  'find_nodes',
  'get_settings_snapshot',
  'get_document',
])
/** 写工具名集合：映射为 AiCommand 走「整批预览 → 确认 → 执行」通道。 */
export const WRITE_TOOL_NAMES = new Set([
  'create_node',
  'delete_node',
  'update_node_spec',
  'connect_edge',
  'disconnect_edge',
  'upsert_character',
  'upsert_location',
  'upsert_document',
  'batch',
])

/** LLM 参数安全字符串化：非字符串（对象/数组/数字）一律归空，
 * 避免 '[object Object]' 之类的默认串化潜入命令字段（S6551）。 */
const asId = (v: unknown): string => (typeof v === 'string' ? v : '')

/** patch 参数形状守卫：非纯对象回退为空补丁，由下游校验器把关。 */
const asPatch = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}

/** 单工具 → 单命令的映射表（S3776：替代 if/else 链）；batch 一对多，循环内单独处理。 */
const WRITE_MAPPERS: Record<
  string,
  (args: Record<string, unknown>) => AiCommand
> = {
  create_node: (a) => ({
    op: 'create_node',
    nodeType: asId(a.nodeType),
    ref: a.ref,
    data: a.data,
    reason: a.reason,
  }),
  update_node_spec: (a) => ({
    op: 'update_node',
    nodeId: asId(a.nodeId),
    patch: asPatch(a.patch),
    reason: a.reason,
  }),
  delete_node: (a) => ({
    op: 'delete_node',
    nodeId: asId(a.nodeId),
    reason: a.reason,
  }),
  connect_edge: (a) => ({
    op: 'connect_edge',
    sourceId: asId(a.sourceId),
    targetId: asId(a.targetId),
    edgeKind: a.edgeKind,
    optionIndex: a.optionIndex,
    reason: a.reason,
  }),
  disconnect_edge: (a) => ({
    op: 'disconnect_edge',
    sourceId: asId(a.sourceId),
    targetId: asId(a.targetId),
    reason: a.reason,
  }),
  // 设定实体（issue 44）：fields 归对象、entityId 原样透传，畸形值由折叠层
  // 整批拒绝——缺省 entityId = 新建；在场但非字符串/空白不是新建通道
  upsert_character: (a) => ({
    op: 'upsert_character' as const,
    ...(a.entityId !== undefined ? { entityId: a.entityId } : {}),
    ref: a.ref,
    fields: asPatch(a.fields),
    reason: a.reason,
  }),
  upsert_location: (a) => ({
    op: 'upsert_location' as const,
    ...(a.entityId !== undefined ? { entityId: a.entityId } : {}),
    ref: a.ref,
    fields: asPatch(a.fields),
    reason: a.reason,
  }),
  // 设定文档（issue 56）：同实体口径——fields 归对象、entityId 原样透传，
  // 畸形值由折叠层整批拒绝；relatedIds 条目保持原样交给两阶段校验
  upsert_document: (a) => ({
    op: 'upsert_document' as const,
    ...(a.entityId !== undefined ? { entityId: a.entityId } : {}),
    fields: asPatch(a.fields),
    reason: a.reason,
  }),
}

/** 写工具注册表自有键查找（issue #258）：原型成员名不得命中继承属性充当工具。 */
function writeMapperOf(
  name: string,
): ((args: Record<string, unknown>) => AiCommand) | undefined {
  return Object.prototype.hasOwnProperty.call(WRITE_MAPPERS, name)
    ? WRITE_MAPPERS[name]
    : undefined
}

/** batch 内单条命令归一：模型常把工具名当 op 写进批次
 * （update_node_spec）——在此归一为命令词表。 */
function normalizeBatchCommand(cmd: unknown): AiCommand {
  const isSpecAlias =
    typeof cmd === 'object' &&
    cmd !== null &&
    !Array.isArray(cmd) &&
    (cmd as { op?: unknown }).op === 'update_node_spec'
  if (isSpecAlias)
    return {
      ...(cmd as Record<string, unknown>),
      op: 'update_node',
    } as AiCommand
  return cmd as AiCommand
}

/**
 * provider 回复 tool_calls 的信任边界形状守卫（issue #127，所有者裁决）：
 * 外壳畸形（非数组 / 成员非对象 / 缺 function 对象 / name、id 非字符串 /
 * arguments 在场而非字符串）属 provider 协议故障，不是模型可修正的生成
 * 错误——不进纠错回喂，由调用方以结构化诊断直接中止本轮。arguments
 * 缺省被下游 \`|| '{}'\` 容忍，不计形状错误；type 字段消费侧不使用，
 * 不校验。外壳合法后，arguments 字符串内容坏 JSON、未知工具名等仍走
 * toolCallsToCommands 的内容级 errors 通道（纠错回喂）。
 */
export function toolCallsShapeDiagnostic(calls: unknown): string | null {
  if (calls === undefined || calls === null) return null
  if (!Array.isArray(calls)) return 'tool_calls 不是数组'
  for (let i = 0; i < calls.length; i += 1) {
    const c = calls[i]
    if (typeof c !== 'object' || c === null || Array.isArray(c))
      return `tool_calls 第 ${i + 1} 项不是对象`
    if (typeof (c as { id?: unknown }).id !== 'string')
      return `tool_calls 第 ${i + 1} 项的 id 不是字符串`
    const fn = (c as { function?: unknown }).function
    if (typeof fn !== 'object' || fn === null || Array.isArray(fn))
      return `tool_calls 第 ${i + 1} 项缺 function 对象`
    const { arguments: args, name } = fn as {
      name?: unknown
      arguments?: unknown
    }
    if (typeof name !== 'string' || name === '')
      return `tool_calls 第 ${i + 1} 项的 function.name 不是非空字符串`
    if (args !== undefined && typeof args !== 'string')
      return `tool_calls 第 ${i + 1} 项的 function.arguments 不是字符串`
  }
  return null
}

/** 一次读工具调用的解析结果：就地执行后按 id 回喂 role:'tool' 消息。 */
export interface ReadRequest {
  /** tool_call id，回喂 role:'tool' 消息时透传。 */
  id: string
  name: string
  args: Record<string, unknown>
}

/** tool_calls 解析产出：写命令、读请求与解析失败文案三路分流。 */
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
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
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
    const mapper = writeMapperOf(name)
    if (mapper) {
      commands.push(mapper(args))
      continue
    }
    if (name === 'batch') {
      const inner = args.commands
      if (Array.isArray(inner))
        commands.push(...inner.map(normalizeBatchCommand))
      else errors.push(`batch 工具（${c.id}）：commands 不是数组`)
      continue
    }
    errors.push(`未知工具：${name}（${c.id}）`)
  }

  return { commands, readRequests, errors }
}
