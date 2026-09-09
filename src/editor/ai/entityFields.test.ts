import { describe, expect, it } from 'vitest'
import {
  AI_ENTITY_FIELDS,
  entityFieldTableText,
  settingsSnapshotText,
} from './entityFields'
import { EMPTY_SETTINGS } from '../settings'

describe('AI_ENTITY_FIELDS（issue 44：实体字段协议单一来源）', () => {
  it('角色/地点各含 name；可选字段为 bio/note；键集与校验白名单同源', () => {
    expect(AI_ENTITY_FIELDS.character.map((f) => f.key)).toEqual(['name', 'bio'])
    expect(AI_ENTITY_FIELDS.location.map((f) => f.key)).toEqual(['name', 'note'])
    for (const fields of Object.values(AI_ENTITY_FIELDS)) {
      for (const f of fields) {
        expect(['string', 'integer', 'boolean', 'array']).toContain(f.type)
        expect(f.desc.length).toBeGreaterThan(0)
      }
    }
  })

  it('entityFieldTableText 生成「种类: 字段(类型) 说明」行式文本', () => {
    const text = entityFieldTableText()
    expect(text).toContain('character:')
    expect(text).toContain('location:')
    expect(text).toContain('name(string)')
    expect(text).toContain('bio(string)')
    expect(text).toContain('note(string)')
  })
})

describe('settingsSnapshotText（get_settings_snapshot 读工具的返回文本）', () => {
  it('列出角色/地点的 id、名称与小传/备注；不暴露 UI 专属字段（gradient）', () => {
    const text = settingsSnapshotText({
      characters: [
        { id: 'ch-1', name: '陈默', gradient: 'linear-gradient(1,2)', bio: '落魄侦探' },
        { id: 'ch-2', name: '阿岚', gradient: 'linear-gradient(3,4)' },
      ],
      locations: [{ id: 'loc-1', name: '茶馆', note: '老城区' }],
    })
    const parsed = JSON.parse(text) as {
      characters: Array<Record<string, unknown>>
      locations: Array<Record<string, unknown>>
    }
    expect(parsed.characters[0]).toEqual({ id: 'ch-1', name: '陈默', bio: '落魄侦探' })
    expect(parsed.characters[1]).toEqual({ id: 'ch-2', name: '阿岚' })
    expect(parsed.locations[0]).toEqual({ id: 'loc-1', name: '茶馆', note: '老城区' })
    expect(text).not.toContain('gradient')
  })

  it('空设定集返回空桶；props/documents 只给只读清单（首期不对 AI 开放写）', () => {
    const empty = JSON.parse(settingsSnapshotText(EMPTY_SETTINGS)) as Record<string, unknown>
    expect(empty).toEqual({ characters: [], locations: [] })

    const text = settingsSnapshotText({
      characters: [],
      locations: [],
      props: [{ id: 'prop-1', name: '怀表' }],
      documents: [{ id: 'doc-1', title: '人物小传', body: '……', relatedIds: [] }],
    })
    const parsed = JSON.parse(text) as {
      props?: Array<Record<string, unknown>>
      documents?: Array<Record<string, unknown>>
    }
    expect(parsed.props).toEqual([{ id: 'prop-1', name: '怀表' }])
    expect(parsed.documents).toEqual([{ id: 'doc-1', title: '人物小传' }])
    expect(text).not.toContain('……')
  })
})
