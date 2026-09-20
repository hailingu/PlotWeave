/**
 * 模型写工具的完整参数形状（#75）：从字段协议生成 data/patch/fields，
 * batch 按 op 与创建类型区分成员。仅描述推荐输出，运行时仍由批次校验把关。
 */
import {
  type AiNodeFieldType,
  AI_NODE_FIELDS,
  nodeFieldTableText,
  type AiFieldSpec,
} from './nodeFields'
import {
  AI_DOCUMENT_FIELDS,
  AI_ENTITY_FIELDS,
  documentFieldTableText,
  entityFieldTableText,
  type EntityKind,
} from './entityFields'

/** 编排命令 schema 所需的对象形状，保留 properties 供批次成员复用。 */
interface ObjectSchema extends Record<string, unknown> {
  properties: Record<string, unknown>
  required: string[]
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): ObjectSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const text = (description: string) => ({ type: 'string', description })
const token = (description: string) => ({
  ...text(description),
  pattern: String.raw`\S`,
})
const reason = text('改动理由')
const ref = token('本批临时别名；不是持久 id，供后续命令引用')
// 键源唯一（AI_NODE_FIELDS 的键即类型清单）；as 收窄是 Object.keys 的
// 标准补偿，非逐点断言（issue #230）
const nodeTypes = Object.keys(AI_NODE_FIELDS) as AiNodeFieldType[]

/** 实体名称的通道化 schema：在协议表生成形状（含 issue #170 的 maxLength
 * 体积预算）上叠加非空白 pattern 与通道文案——整体替换会丢掉预算，
 * 模型可见协议与校验边界漂移（PR #204 评审）。 */
const entityNameSchema = (
  generated: unknown,
  description: string,
): Record<string, unknown> => ({
  ...(generated as Record<string, unknown>),
  description,
  pattern: String.raw`\S`,
})

/** 字段键、基础类型、说明与嵌套值结构从同一协议表生成。 */
function fieldsSchema(fields: readonly AiFieldSpec[]): ObjectSchema {
  return objectSchema(
    Object.fromEntries(
      fields.map((field) => [
        field.key,
        {
          type: field.type,
          description: field.desc,
          ...field.schema,
        },
      ]),
    ),
  )
}

const nodeData = (type: AiNodeFieldType) => fieldsSchema(AI_NODE_FIELDS[type])
const nodeDataUnion = {
  anyOf: nodeTypes.map(nodeData),
  description: `根据 nodeType 选择字段对象；只写要定制的字段，其余用默认。\n${nodeFieldTableText()}`,
}

/** 实体的新增字段和局部更新共用形状；name 的存在性由 batch 的模式变体表达。 */
function entityParameters(kind: EntityKind): ObjectSchema {
  const fields = fieldsSchema(AI_ENTITY_FIELDS[kind])
  fields.properties.name = entityNameSchema(
    fields.properties.name,
    '实体名称：新增必填，修改时可省略',
  )
  return objectSchema(
    {
      entityId: token('仅修改时提供目标实体 id；新增必须省略'),
      ref,
      fields: {
        ...fields,
        minProperties: 1,
        description: entityFieldTableText(),
      },
      reason,
    },
    ['fields'],
  )
}

/** relatedIds 的值结构（issue 56）：kind+id 成对，id 须为既有实体或本批实体
 * ref。单写工具与批次变体共用同一对象，避免两条通道形状漂移。 */
const relatedIdsSchema = {
  type: 'array',
  // relatedIds 条目按 key 定位（issue #230：数组下标读取的缺失分支以
  // 查找表达；字段表若重组，描述随查找落空而非错位到别的字段）
  description: AI_DOCUMENT_FIELDS.find((f) => f.key === 'relatedIds')?.desc,
  items: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['character', 'location'],
        description: '关联条目种类',
      },
      id: token('实体 id 或本批实体 ref 别名'),
    },
    required: ['kind', 'id'],
    additionalProperties: false,
  },
}

/** 设定文档（issue 56）：relatedIds 为 kind+id 对数组，id 须为既有实体或本批
 * 实体 ref；title/body 整体替换。新增/修改共用 fields 形状，title 的模式
 * 要求由 batch 变体表达。 */
function documentParameters(): ObjectSchema {
  const fields = fieldsSchema(AI_DOCUMENT_FIELDS)
  fields.properties.relatedIds = relatedIdsSchema
  return objectSchema(
    {
      entityId: token('仅修改时提供目标文档 id；新增必须省略'),
      fields: {
        ...fields,
        minProperties: 1,
        description: documentFieldTableText(),
      },
      reason,
    },
    ['fields'],
  )
}

/** 单写工具/批次折叠共享的写操作名联合（issue #230：注册表按名收窄，
 * 索引读取免缺失兜底）。 */
export type AiWriteOp =
  | 'create_node'
  | 'update_node_spec'
  | 'delete_node'
  | 'connect_edge'
  | 'disconnect_edge'
  | 'upsert_character'
  | 'upsert_location'
  | 'upsert_document'

/** 单写工具的参数 schema：与 batch 的对应 op 复用，避免两条通道形状漂移。 */
export const WRITE_PARAMETERS: Record<AiWriteOp, ObjectSchema> = {
  create_node: objectSchema(
    {
      nodeType: { type: 'string', enum: nodeTypes },
      ref,
      data: nodeDataUnion,
      reason,
    },
    ['nodeType'],
  ),
  update_node_spec: objectSchema(
    {
      nodeId: token('目标节点 id 或本批 ref'),
      patch: { ...nodeDataUnion, minProperties: 1 },
      reason,
    },
    ['nodeId', 'patch'],
  ),
  delete_node: objectSchema(
    { nodeId: token('目标节点 id 或本批 ref'), reason },
    ['nodeId'],
  ),
  connect_edge: objectSchema(
    {
      sourceId: token('起点节点 id 或本批 ref'),
      targetId: token('终点节点 id 或本批 ref'),
      edgeKind: {
        type: 'string',
        enum: ['sequence', 'branch', 'attach'],
        description:
          '缺省 sequence；对白属于剧情流，只有 scene→shot 使用 attach',
      },
      optionIndex: {
        type: 'integer',
        minimum: 0,
        description: 'edgeKind=branch 时必填，0 基选项下标',
      },
      reason,
    },
    ['sourceId', 'targetId'],
  ),
  disconnect_edge: objectSchema(
    {
      sourceId: token('起点节点 id'),
      targetId: token('终点节点 id'),
      reason,
    },
    ['sourceId', 'targetId'],
  ),
  upsert_character: entityParameters('character'),
  upsert_location: entityParameters('location'),
  upsert_document: documentParameters(),
}

/** 将单工具参数封装成含 op 的批次成员；内部别名 update_node_spec 不进入 op。 */
function commandSchema(op: string, parameters: ObjectSchema): ObjectSchema {
  return objectSchema(
    { op: { type: 'string', enum: [op] }, ...parameters.properties },
    ['op', ...parameters.required],
  )
}

/** 创建类型与 data 绑定；实体新增必须有 name，修改必须有 entityId。 */
function commandVariants(): ObjectSchema[] {
  const variants = nodeTypes.map((nodeType) =>
    commandSchema('create_node', {
      ...WRITE_PARAMETERS.create_node,
      properties: {
        ...WRITE_PARAMETERS.create_node.properties,
        nodeType: { type: 'string', enum: [nodeType] },
        data: nodeData(nodeType),
      },
    }),
  )
  for (const name of [
    'update_node_spec',
    'delete_node',
    'connect_edge',
    'disconnect_edge',
  ] as const) {
    variants.push(
      commandSchema(
        name === 'update_node_spec' ? 'update_node' : name,
        WRITE_PARAMETERS[name],
      ),
    )
  }
  for (const kind of ['character', 'location'] as const) {
    const parameters = WRITE_PARAMETERS[`upsert_${kind}`]
    const createProperties = { ref, reason }
    const fields = fieldsSchema(AI_ENTITY_FIELDS[kind])
    fields.properties.name = entityNameSchema(
      fields.properties.name,
      '新实体名称',
    )
    variants.push(
      commandSchema(
        `upsert_${kind}`,
        objectSchema(
          { ...createProperties, fields: { ...fields, required: ['name'] } },
          ['fields'],
        ),
      ),
      commandSchema(`upsert_${kind}`, {
        ...parameters,
        required: ['entityId', 'fields'],
      }),
    )
  }
  // 设定文档（issue 56）：新建必须有 title；修改必须同时带 entityId
  const documentFields = fieldsSchema(AI_DOCUMENT_FIELDS)
  documentFields.properties.relatedIds = relatedIdsSchema
  variants.push(
    commandSchema(
      'upsert_document',
      objectSchema(
        {
          reason,
          fields: { ...documentFields, required: ['title'] },
        },
        ['fields'],
      ),
    ),
    commandSchema('upsert_document', {
      ...WRITE_PARAMETERS.upsert_document,
      required: ['entityId', 'fields'],
    }),
  )
  return variants
}

/** 完整批次参数：每项均有显式 op、参数与嵌套字段，空批次不构成交付。 */
export const BATCH_PARAMETERS = objectSchema(
  {
    commands: {
      type: 'array',
      minItems: 1,
      items: { anyOf: commandVariants() },
      description: `一次改动的完整命令数组，按执行依赖排序。\n${nodeFieldTableText()}\n${entityFieldTableText()}\n${documentFieldTableText()}`,
    },
  },
  ['commands'],
)
