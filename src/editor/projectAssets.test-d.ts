/**
 * 项目资产归一化入口的编译期契约探针（issue #729）：仅由严格类型检查
 * 入口编译（tsconfig.strict.json——主构建与测试排除 *.test-d.ts）。
 * 归一化函数是 unknown 线值 → AssetRef 的唯一构造出口：签名必须诚实
 * 接受 unknown（IPC/生成命令的返回值无类型标注，形状契约由函数内全量
 * 校验背书），调用点不得再散布 `as never` 等裸转换。断言以条件类型的
 * 静态求值表达：签名收窄回 RawAssetRef 时探针类型不再满足约束，严格
 * 检查非零退出。
 */
import type { AssetRef } from '../model/document'
import { normalizeAssetRef } from './projectAssets'

type Extends<A, B> = A extends B ? true : false
type Expect<T extends true> = T

/** 参数逆变方向：只有接受 unknown 的函数才可赋给 unknown 签名——
 * RawAssetRef | null 形态的旧签名在此方向不成立（issue #729 红基线）。 */
export type NormalizeAssetRefAcceptsUnknownWire = Expect<
  Extends<typeof normalizeAssetRef, (raw: unknown) => AssetRef>
>
