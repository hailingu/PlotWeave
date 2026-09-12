import type { ProjectSettings } from '../settings'

/**
 * AI 设定实体字段协议的单一真相（issue 44，机制同 nodeFields.ts / issue 41）：
 * upsert_character / upsert_location 工具描述、系统提示词与整批校验白名单
 * 都从这里生成，三方不再各自漂移。字段集合与 settings.ts 的
 * CharacterEntity / LocationEntity 一一对应；props 首期不开放 AI 写入，
 * 只出现在读工具的只读清单里。
 * 设定文档字段协议（AI_DOCUMENT_FIELDS，issue 56）同源管理：upsert_document
 * 工具描述与校验白名单共用；文档正文经 get_document 按需读取，不进快照。
 */

/** 单个 AI 可写实体字段的协议描述。 */
export interface AiEntityFieldSpec {
  /** 字段键（= 实体属性名，校验白名单的直接来源）。 */
  key: string
  /** 值类型（JSON 词汇）。 */
  type: 'string' | 'integer' | 'boolean' | 'array'
  /** 人读一句话说明（进系统提示与工具描述）。 */
  desc: string
}

/** 各 AI 可写实体种类的字段协议表。gradient 由应用分配，不接受模型指定。 */
export const AI_ENTITY_FIELDS: Record<'character' | 'location', readonly AiEntityFieldSpec[]> = {
  character: [
    { key: 'name', type: 'string', desc: '角色名（创建必填）' },
    { key: 'bio', type: 'string', desc: '一句小传（可省）' },
  ],
  location: [
    { key: 'name', type: 'string', desc: '地点名（创建必填）' },
    { key: 'note', type: 'string', desc: '备注（可省）' },
  ],
}

/** 设定文档（SettingsDocument）的 AI 可写字段协议（issue 56）。title 是文档
 * 在清单中的身份（创建必填、修改不许清空）；body 为长篇正文（整体替换）；
 * relatedIds 为关联条目（kind + id 成对，整体替换，id 可用本批实体 ref）。 */
export const AI_DOCUMENT_FIELDS: readonly AiEntityFieldSpec[] = [
  { key: 'title', type: 'string', desc: '文档标题（创建必填，修改不许清空）' },
  { key: 'body', type: 'string', desc: '长篇正文，整体替换（可省）' },
  {
    key: 'relatedIds',
    type: 'array',
    desc: '关联设定条目，整体替换：[{kind:"character"|"location", id}]，id 须为既有实体或本批 ref（可省）',
  },
]

/** 实体种类（角色 / 地点是两个独立 id 空间，引用类型校验按此判定）。 */
export type EntityKind = 'character' | 'location'

/**
 * 实体引用 token 的解析口径（§8.1 场景/对白对设定集的结构化引用）：
 * token 按引用位期望的种类（expect）解析——角色与地点是两个独立 id 空间，
 * 同一 id 在两桶合法共存，不得因固定桶序先命中而误判种类；
 * null = 未知实体。
 */
export interface EntityTokenScope {
  kindOf: (token: string, expect: EntityKind) => EntityKind | null
}

/** 实体种类 → 人读标签（错误文案与预览标签共用）。 */
export const ENTITY_KIND_LABELS: Record<EntityKind, string> = {
  character: '角色',
  location: '地点',
}

/** 生成「种类: 字段(类型) 说明」行式协议文本：系统提示与工具描述共用
 * 同一函数输出，保证两处逐字一致、随协议表同步演进。 */
export function entityFieldTableText(): string {
  return Object.entries(AI_ENTITY_FIELDS)
    .map(([kind, fields]) => {
      const row = fields.map((f) => `${f.key}(${f.type}) ${f.desc}`).join('；')
      return `${kind}: ${row}`
    })
    .join('\n')
}

/** 设定文档字段协议行式文本（同 entityFieldTableText 口径，issue 56）。 */
export function documentFieldTableText(): string {
  const row = AI_DOCUMENT_FIELDS.map((f) => `${f.key}(${f.type}) ${f.desc}`).join('；')
  return `document: ${row}`
}

/**
 * get_settings_snapshot 读工具的返回文本：角色/地点给 id、名称与小传/备注
 * （写 characterIds/locationId/speaker 前复用已有实体的锚点）；gradient 是
 * UI 专属字段不进快照；props 只给只读清单（id + 名称）。documents 给
 * id + 标题元数据（issue 56）：正文与关联不进快照——长篇文本按需经
 * get_document 读取，避免上下文膨胀。
 */
export function settingsSnapshotText(s: ProjectSettings): string {
  const characters = s.characters.map(({ id, name, bio }) => ({
    id,
    name,
    ...(bio !== undefined && bio !== '' ? { bio } : {}),
  }))
  const locations = s.locations.map(({ id, name, note }) => ({
    id,
    name,
    ...(note !== undefined && note !== '' ? { note } : {}),
  }))
  return JSON.stringify({
    characters,
    locations,
    ...(s.props ? { props: s.props.map(({ id, name }) => ({ id, name })) } : {}),
    ...(s.documents
      ? { documents: s.documents.map(({ id, title }) => ({ id, title })) }
      : {}),
  })
}
