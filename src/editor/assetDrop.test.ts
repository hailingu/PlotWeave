import { describe, expect, it } from 'vitest'
import { bindAssetRefPatch, shotRefKindForAsset } from './assetDrop'
import type { ShotRef } from './nodes/types'

describe('shotRefKindForAsset（库资产 → 分镜引用位 kind 映射，§4.2/§7.3）', () => {
  it('角色/场景分类的 image/* 映射到对应引用位 kind', () => {
    expect(shotRefKindForAsset({ kind: 'character', mime: 'image/png' })).toBe('character')
    expect(shotRefKindForAsset({ kind: 'location', mime: 'image/webp' })).toBe('location')
  })

  it('audio/* 一律落音频位（不受库分类约束）；错配家族与非媒体类型拒绝', () => {
    expect(shotRefKindForAsset({ kind: 'reference', mime: 'audio/mpeg' })).toBe('audio')
    expect(shotRefKindForAsset({ kind: 'character', mime: 'audio/wav' })).toBe('audio')
    expect(shotRefKindForAsset({ kind: 'location', mime: 'audio/mpeg' })).toBe('audio')
    // 引用位 kind 与 MIME 家族强约束（shotRefMimeMatches 同域）：错配不放行
    expect(shotRefKindForAsset({ kind: 'character', mime: 'video/mp4' })).toBeNull()
    expect(shotRefKindForAsset({ kind: 'location', mime: 'video/mp4' })).toBeNull()
    // 无引用位语义的库分类不绑
    expect(shotRefKindForAsset({ kind: 'reference', mime: 'image/png' })).toBeNull()
    expect(shotRefKindForAsset({ kind: 'other', mime: 'application/pdf' })).toBeNull()
  })
})

describe('bindAssetRefPatch（引用位绑定补丁）', () => {
  it('追加引用位 { id, kind, assetId }（label 缺省——互斥判别联合的引用位形态）', () => {
    const refs: ShotRef[] = [{ id: 'r1', kind: 'character', label: '自由位' }]
    const patch = bindAssetRefPatch(refs, 'character', 'pa-1')
    expect(patch?.refs).toHaveLength(2)
    expect(patch?.refs[1]).toMatchObject({ kind: 'character', assetId: 'pa-1' })
    expect(patch?.refs[1].id).not.toBe('')
    expect('label' in (patch?.refs[1] ?? {})).toBe(false)
    // 原数组不被改写（不可变补丁）
    expect(refs).toHaveLength(1)
  })

  it('同一资产在同卡已绑定返回 null（去重）', () => {
    const refs: ShotRef[] = [{ id: 'r2', kind: 'location', assetId: 'pa-1' }]
    expect(bindAssetRefPatch(refs, 'location', 'pa-1')).toBeNull()
  })
})
