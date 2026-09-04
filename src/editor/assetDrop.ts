/**
 * 库资产 → 分镜卡引用位绑定的纯逻辑（§7.3 拷贝进项目 + §4.2 引用位契约）。
 * 引用位 kind 与资产 MIME 家族强约束与归一化层（convert.ts
 * shotRefMimeMatches）同域：编辑边界不放行注定不可用的引用。
 */
import { shotRefMimeMatches } from '../model/convert'
import { uid } from '../uid'
import type { ShotRef } from './nodes/types'

/** 库资产可绑的引用位 kind：audio/* 一律落音频位；角色/场景分类的 image/*
 * 映射到对应 kind；其余分类与错配 MIME 返回 null（该资产无引用位语义）。 */
export function shotRefKindForAsset(asset: { kind: string; mime: string }): ShotRef['kind'] | null {
  if (asset.mime.startsWith('audio/')) return 'audio'
  const kind = asset.kind
  if (kind !== 'character' && kind !== 'location') return null
  if (!shotRefMimeMatches(kind, asset.mime)) return null
  return kind
}

/** 绑定补丁：向 refs 追加引用位形态（assetId 与 label 互斥，§4.2）。
 * 同一资产在同卡已绑定返回 null（去重），调用方不得重复入栈。 */
export function bindAssetRefPatch(
  refs: ShotRef[],
  kind: ShotRef['kind'],
  assetId: string,
): { refs: ShotRef[] } | null {
  if (refs.some((r) => r.assetId === assetId)) return null
  return { refs: [...refs, { id: uid('ref'), kind, assetId }] }
}
