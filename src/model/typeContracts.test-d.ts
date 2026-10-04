/**
 * 领域类型的编译期契约探针（issue #231）：仅由严格类型检查入口编译
 * （tsconfig.strict.json——主构建与测试排除 *.test-d.ts），断言
 * 「字段不得存在」的判别联合成员拒绝显式 undefined、合法的字段清除
 * 语义保留。断言以条件类型的静态求值表达：契约被破坏时探针类型
 * 不再满足约束，严格检查非零退出。本文件只引用 model 自有类型
 * （issue #353：模型层编译期不依赖 editor/）；编辑器运行态与补丁面的
 * 同款探针见 src/editor/nodes/sessionCompat.test-d.ts。
 */
import type {
  DerivedMeta,
  ImageMeta,
  ProjectDocument,
  SceneSpec,
  ShotMeta,
  ShotRef,
} from './document'
import { CURRENT_SCHEMA_VERSION } from './document'
import type { SceneSessionData, SessionNode } from './session'

type Extends<A, B> = A extends B ? true : false
type Expect<T extends true> = T
type Reject<R extends false> = R
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false

/** 持久化侧 ShotRef（model/document）：引用位/自由位互斥——镜像字段既不
 * 接受字符串也不接受显式 undefined（exactOptionalPropertyTypes 下
 * `?: never` 才同时拒绝两者）。 */
export type ShotRefReferenceArmRejectsLabel = Reject<
  Extends<
    { id: string; kind: 'character'; assetId: string; label: undefined },
    ShotRef
  >
>
export type ShotRefFreeArmRejectsAssetId = Reject<
  Extends<
    { id: string; kind: 'character'; label: string; assetId: undefined },
    ShotRef
  >
>
/** 合法形态仍被接受（负向契约不得误伤正向用法）。 */
export type ShotRefReferenceArmAccepts = Expect<
  Extends<{ id: string; kind: 'audio'; assetId: string }, ShotRef>
>
export type ShotRefFreeArmAccepts = Expect<
  Extends<{ id: string; kind: 'location'; label: 'L' }, ShotRef>
>

/** 派生/分镜/图片 meta 的禁写字段拒绝显式 undefined。 */
export type DerivedMetaRejectsLabel = Reject<
  Extends<{ episodeNo: number; label: undefined }, DerivedMeta>
>
export type ShotMetaRejectsLabelAndEpisodeNo = Reject<
  Extends<{ label: undefined; episodeNo: undefined }, ShotMeta>
>
export type ImageMetaRejectsLabelAndEpisodeNo = Reject<
  Extends<{ label: undefined; episodeNo: undefined }, ImageMeta>
>

/** 会话侧场景 data（model/session，issue #353）：name/time 为会话必填
 * （存储 spec 的 time 可选、加载归一化兜底空串），缺失形状被拒绝。 */
export type SceneSessionDataRejectsMissingTime = Reject<
  Extends<
    Omit<SceneSpec, 'time'> & { name: string; episodeNo?: number },
    SceneSessionData
  >
>
export type SceneSessionDataAcceptsFlattenedShape = Expect<
  Extends<
    // 匿名对象字面量类型（带隐式索引签名）——与 fromStoryNode 的展开构造
    // 同构；接口别名无隐式索引签名，不能作为本探针的源形状
    {
      sceneNo: number
      interior: boolean
      locationId?: string
      time: string
      weather?: string
      synopsis: string
      characterIds: string[]
      name: string
      episodeNo?: number
    },
    SceneSessionData
  >
>

/** 会话节点按 type 判别（model/session）：scene 成员的 data 精确为
 * SceneSessionData，编辑器运行态经结构兼容进入（sessionCompat.test-d）。 */
type SessionSceneMember = Extract<SessionNode, { type: 'scene' }>
export type SessionNodeDiscriminatesByType = Expect<
  Equal<SessionSceneMember['data'], SceneSessionData>
>

/** 当前文档 schemaVersion 的编译期判别（issue #312）：ProjectDocument 表示
 * 「当前归一化文档」，其版本成员恰为 CURRENT_SCHEMA_VERSION 的字面量类型——
 * 任意 number、旧版本（0）与未来版本（2）都无法静态构造当前文档；未信任/
 * 旧版本输入的判型收口在 parseProject 的 unknown 原始边界（§11.1），
 * 不经本形状。 */
type DocumentVersionProbe = Pick<ProjectDocument, 'schemaVersion'>
export type DocumentVersionIsCurrentLiteral = Expect<
  Equal<ProjectDocument['schemaVersion'], typeof CURRENT_SCHEMA_VERSION>
>
export type DocumentVersionStillNumeric = Expect<
  Extends<ProjectDocument['schemaVersion'], number>
>
export type DocumentAcceptsCurrentVersion = Expect<
  Extends<{ schemaVersion: 1 }, DocumentVersionProbe>
>
export type DocumentRejectsArbitraryNumber = Reject<
  Extends<{ schemaVersion: number }, DocumentVersionProbe>
>
export type DocumentRejectsLegacyZero = Reject<
  Extends<{ schemaVersion: 0 }, DocumentVersionProbe>
>
export type DocumentRejectsFutureVersion = Reject<
  Extends<{ schemaVersion: 2 }, DocumentVersionProbe>
>
