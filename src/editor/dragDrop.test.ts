import { describe, expect, it } from 'vitest'
import {
  PW_ENTITY_MIME,
  PW_LIBRARY_ASSET_MIME,
  readEntityPayload,
  readLibraryAssetPayload,
} from './dragDrop'

const dt = (raw: string | undefined) => ({
  getData: (type: string) => (type === PW_ENTITY_MIME ? (raw ?? '') : ''),
})

describe('readEntityPayload（拖拽 MIME 协议解析）', () => {
  it('合法角色/地点载荷往返解析', () => {
    expect(
      readEntityPayload(dt(JSON.stringify({ kind: 'character', id: 'ch1', name: '林晚' }))),
    ).toEqual({ kind: 'character', id: 'ch1', name: '林晚' })
    expect(
      readEntityPayload(dt(JSON.stringify({ kind: 'location', id: 'loc1', name: '天台' }))),
    ).toEqual({ kind: 'location', id: 'loc1', name: '天台' })
  })

  it('未知 kind / 字段缺失 / 非法 JSON / 空载荷一律返回 null', () => {
    expect(readEntityPayload(dt(JSON.stringify({ kind: 'prop', id: 'x', name: 'y' })))).toBeNull()
    expect(readEntityPayload(dt(JSON.stringify({ kind: 'character', id: 1, name: 'x' })))).toBeNull()
    expect(readEntityPayload(dt(JSON.stringify({ kind: 'character', id: 'ch1' })))).toBeNull()
    expect(readEntityPayload(dt('{broken'))).toBeNull()
    expect(readEntityPayload(dt(''))).toBeNull()
    expect(readEntityPayload(dt(undefined))).toBeNull()
  })
})

describe('readLibraryAssetPayload（资产库 → 画布拖拽协议，§7.3）', () => {
  const dtLib = (raw: string | undefined) => ({
    getData: (type: string) => (type === PW_LIBRARY_ASSET_MIME ? (raw ?? '') : ''),
  })

  it('合法载荷往返解析', () => {
    expect(
      readLibraryAssetPayload(
        dtLib(JSON.stringify({ id: 'la-1', name: '林晚.png', kind: 'character', mime: 'image/png' })),
      ),
    ).toEqual({ id: 'la-1', name: '林晚.png', kind: 'character', mime: 'image/png' })
  })

  it('字段缺失/类型异常/非法 JSON/空载荷一律返回 null', () => {
    expect(
      readLibraryAssetPayload(dtLib(JSON.stringify({ id: 'la-1', name: 'x', kind: 'character' }))),
    ).toBeNull()
    expect(
      readLibraryAssetPayload(dtLib(JSON.stringify({ id: 7, name: 'x', kind: 'c', mime: 'm' }))),
    ).toBeNull()
    expect(readLibraryAssetPayload(dtLib('{broken'))).toBeNull()
    expect(readLibraryAssetPayload(dtLib(''))).toBeNull()
    expect(readLibraryAssetPayload(dtLib(undefined))).toBeNull()
  })
})
