/**
 * 模型写工具的完整参数形状（#75）：从字段协议生成 data/patch/fields，
 * batch 按 op 与创建类型区分成员。仅描述推荐输出，运行时仍由批次校验把关。
 */
import { AI_NODE_FIELDS, nodeFieldTableText, type AiFieldSpec } from './nodeFields'
import { AI_ENTITY_FIELDS, entityFieldTableText, type EntityKind } from './entityFields'

/** 编排命令 schema 所需的对象形状，保留 properties 供批次成员复用。 */
interface ObjectSchema extends Record<string, unknown> {
  properties: Record<string, unknown>
  required: string[]
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): ObjectSchema => ({
  type: 'object', properties, required, additionalProperties: false,
})
const text = (description: string) => ({ type: 'string', description })
const token = (description: string) => ({ ...text(description), pattern: String.raw`\S` })
const reason = text('改动理由')
const ref = token('本批临时别名；不是持久 id，供后续命令引用')
const nodeTypes = Object.keys(AI_NODE_FIELDS)

/** 字段键、基础类型、说明与嵌套值结构从同一协议表生成。 */
function fieldsSchema(fields: readonly AiFieldSpec[]): ObjectSchema {
  return objectSchema(Object.fromEntries(fields.map((field) => [field.key, {
    type: field.type, description: field.desc, ...field.schema,
  }])))
}

const nodeData = (type: string) => fieldsSchema(AI_NODE_FIELDS[type])
const nodeDataUnion = {
  anyOf: nodeTypes.map(nodeData),
  description: `根据 nodeType 选择字段对象；只写要定制的字段，其余用默认。\n${nodeFieldTableText()}`,
}

/** 实体的新增字段和局部更新共用形状；name 的存在性由 batch 的模式变体表达。 */
function entityParameters(kind: EntityKind): ObjectSchema {
  const fields = fieldsSchema(AI_ENTITY_FIELDS[kind])
  fields.properties.name = token('实体名称：新增必填，修改时可省略')
  return objectSchema({
    entityId: token('仅修改时提供目标实体 id；新增必须省略'), ref,
    fields: { ...fields, minProperties: 1, description: entityFieldTableText() }, reason,
  }, ['fields'])
}

/** 单写工具的参数 schema：与 batch 的对应 op 复用，避免两条通道形状漂移。 */
export const WRITE_PARAMETERS: Record<string, ObjectSchema> = {
  create_node: objectSchema({
    nodeType: { type: 'string', enum: nodeTypes }, ref, data: nodeDataUnion, reason,
  }, ['nodeType']),
  update_node_spec: objectSchema({
    nodeId: token('目标节点 id 或本批 ref'), patch: { ...nodeDataUnion, minProperties: 1 }, reason,
  }, ['nodeId', 'patch']),
  delete_node: objectSchema({ nodeId: token('目标节点 id 或本批 ref'), reason }, ['nodeId']),
  connect_edge: objectSchema({
    sourceId: token('起点节点 id 或本批 ref'), targetId: token('终点节点 id 或本批 ref'),
    edgeKind: { type: 'string', enum: ['sequence', 'branch', 'attach'], description: '缺省 sequence；对白属于剧情流，只有 scene→shot 使用 attach' },
    optionIndex: { type: 'integer', minimum: 0, description: 'edgeKind=branch 时必填，0 基选项下标' }, reason,
  }, ['sourceId', 'targetId']),
  disconnect_edge: objectSchema({
    sourceId: token('起点节点 id'), targetId: token('终点节点 id'), reason,
  }, ['sourceId', 'targetId']),
  upsert_character: entityParameters('character'),
  upsert_location: entityParameters('location'),
}

/** 将单工具参数封装成含 op 的批次成员；内部别名 update_node_spec 不进入 op。 */
function commandSchema(op: string, parameters: ObjectSchema): ObjectSchema {
  return objectSchema({ op: { type: 'string', enum: [op] }, ...parameters.properties }, ['op', ...parameters.required])
}

/** 创建类型与 data 绑定；实体新增必须有 name，修改必须有 entityId。 */
function commandVariants(): ObjectSchema[] {
  const variants = nodeTypes.map((nodeType) => commandSchema('create_node', {
    ...WRITE_PARAMETERS.create_node, properties: { ...WRITE_PARAMETERS.create_node.properties,
      nodeType: { type: 'string', enum: [nodeType] }, data: nodeData(nodeType) },
  }))
  for (const name of ['update_node_spec', 'delete_node', 'connect_edge', 'disconnect_edge']) {
    variants.push(commandSchema(name === 'update_node_spec' ? 'update_node' : name, WRITE_PARAMETERS[name]))
  }
  for (const kind of ['character', 'location'] as const) {
    const parameters = WRITE_PARAMETERS[`upsert_${kind}`]
    const createProperties = { ref, reason }
    const fields = fieldsSchema(AI_ENTITY_FIELDS[kind])
    fields.properties.name = token('新实体名称')
    variants.push(
      commandSchema(`upsert_${kind}`, objectSchema({ ...createProperties,
        fields: { ...fields, required: ['name'] } }, ['fields'])),
      commandSchema(`upsert_${kind}`, { ...parameters, required: ['entityId', 'fields'] }),
    )
  }
  return variants
}

/** 完整批次参数：每项均有显式 op、参数与嵌套字段，空批次不构成交付。 */
export const BATCH_PARAMETERS = objectSchema({ commands: {
  type: 'array', minItems: 1, items: { anyOf: commandVariants() },
  description: `一次改动的完整命令数组，按执行依赖排序。\n${nodeFieldTableText()}\n${entityFieldTableText()}`,
} }, ['commands'])
