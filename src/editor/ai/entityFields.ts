import type { ProjectSettings } from '../settings'

/**
 * AI 设定实体字段协议的单一真相（issue 44，机制同 nodeFields.ts / issue 41）：
 * upsert_character / upsert_location 工具描述、系统提示词与整批校验白名单
 * 都从这里生成，三方不再各自漂移。字段集合与 settings.ts 的
 * CharacterEntity / LocationEntity 一一对应；props / documents 首期不开放
 * AI 写入，只出现在读工具的只读清单里。
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

/** 实体种类（角色 / 地点是两个独立 id 空间，引用类型校验按此判定）。 */
export type EntityKind = 'character' | 'location'

/**
 * 实体引用 token 的解析口径（§8.1 场景/对白对设定集的结构化引用）：
 * token 按引用位期望的种类（expect）解析——角色与地点是两个独立 id 空间，
 * 同一 id 在两桶合法共存，不得因固定桶序先命中而误判种类；
 * 'contingent' = token 指向本批校验失败的 upsert（依赖前序修复自愈，
 * 本轮跳过存在性校验）；null = 未知实体。
 */
export interface EntityTokenScope {
  kindOf: (token: string, expect: EntityKind) => EntityKind | 'contingent' | null
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

/**
 * get_settings_snapshot 读工具的返回文本：角色/地点给 id、名称与小传/备注
 * （写 characterIds/locationId/speaker 前复用已有实体的锚点）；gradient 是
 * UI 专属字段不进快照；props / documents 首期只给只读清单（id + 名称/标题），
 * 正文不进上下文——长篇文档的按需读取随文档 UI 阶段另行开放（issue 44）。
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
