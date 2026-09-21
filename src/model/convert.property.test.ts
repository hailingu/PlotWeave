/** 归一化不变量的生成式测试（issue #232）：围绕已支持信封（v0/v1）与
 * 受控脏注入，验证「输出身份唯一、活动边满足图规则、扩展字段按契约
 * 保留、规范化后再次解析不产生额外修复」与允许拒绝的版本/信封边界。
 *
 * 可复现性：fast-check 失败输出携带 seed 与收缩后的最小样例；设
 * PROPERTY_SEED=<seed> 重跑可精确复现（fc.configureGlobal 注入）。
 * 规模有界（数组 ≤6/桶 ≤4/字符串 ≤8），深度受生成器结构约束。
 * 断言只针对语义结果（parseProject/serializeProject 的可观察契约），
 * 不读取源文件文字、不断言实现布局。 */
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseProject, serializeProject } from './convert'
import type { ProjectContent } from './content'
import { NOW } from './convertFixtures'
import {
  configurePropertyGlobal,
  idArb,
  preservedText,
  shortText,
  finiteNumber,
  isoText,
  type ArbValue,
  assertOutputInvariants,
} from './convert.property.shared'
import { edgeKindOf } from '../editor/graphRules'

const PROJECT_ID = 'p-prop'

beforeAll(configurePropertyGlobal)

/** 容器级扩展字段值：有界深度（标量 / 一层对象 / 一层数组），与
 * fc.jsonObject 的无界深度不同，符合「限制深度/规模」的测试边界。 */
const extensionValue = fc.oneof(
  fc.integer({ min: -5, max: 5 }),
  shortText,
  fc.boolean(),
  fc.record({ k: shortText }),
  fc.array(fc.nat(3), { maxLength: 3 }),
)

type NodeSpecGen = Record<string, unknown>

const sceneNodeArb = fc.record({
  id: idArb('n'),
  type: fc.constant('scene'),
  position: fc.record({ x: finiteNumber, y: finiteNumber }),
  data: fc.record({
    name: shortText,
    sceneNo: fc.nat(3),
    interior: fc.boolean(),
    locationId: fc.option(idArb('loc'), { nil: undefined }),
    time: shortText,
    weather: fc.option(shortText, { nil: undefined }),
    synopsis: shortText,
    characterIds: fc.array(idArb('ch'), { maxLength: 3 }),
    episodeNo: fc.option(fc.nat(3), { nil: undefined }),
  }),
})

const beatNodeArb = fc.record({
  id: idArb('n'),
  type: fc.constant('beat'),
  position: fc.record({ x: finiteNumber, y: finiteNumber }),
  data: fc.record({
    name: shortText,
    tone: shortText,
    episodeNo: fc.option(fc.nat(3), { nil: undefined }),
  }),
})

const dialogueNodeArb = fc.record({
  id: idArb('n'),
  type: fc.constant('dialogue'),
  position: fc.record({ x: finiteNumber, y: finiteNumber }),
  data: fc.record({
    name: shortText,
    lines: fc.array(
      fc.record({
        id: idArb('line'),
        kind: fc.constantFrom('line', 'action'),
        text: shortText,
        speaker: fc.option(idArb('ch'), { nil: undefined }),
        side: fc.option(fc.constantFrom('left', 'right'), { nil: undefined }),
      }),
      { maxLength: 3 },
    ),
  }),
})

const branchNodeArb = fc.record({
  id: idArb('n'),
  type: fc.constant('branch'),
  position: fc.record({ x: finiteNumber, y: finiteNumber }),
  data: fc.record({
    prompt: shortText,
    options: fc.array(fc.record({ id: idArb('opt'), label: shortText }), {
      maxLength: 3,
    }),
    episodeNo: fc.option(fc.nat(3), { nil: undefined }),
  }),
})

const shotRefArb = fc.oneof(
  fc.record({
    id: idArb('ref'),
    kind: fc.constantFrom('character', 'location', 'audio'),
    assetId: idArb('asset'),
  }),
  fc.record({
    id: idArb('ref'),
    kind: fc.constantFrom('character', 'location', 'audio'),
    label: shortText,
  }),
)

const shotNodeArb = fc.record({
  id: idArb('n'),
  type: fc.constant('shot'),
  position: fc.record({ x: finiteNumber, y: finiteNumber }),
  data: fc.record({
    shotNo: fc.nat(3),
    size: shortText,
    picture: shortText,
    prompt: shortText,
    refs: fc.array(shotRefArb, { maxLength: 3 }),
  }),
})

const imageNodeArb = fc.record({
  id: idArb('n'),
  type: fc.constant('image'),
  position: fc.record({ x: finiteNumber, y: finiteNumber }),
  data: fc.record({
    prompt: shortText,
    model: shortText,
    size: shortText,
    outputs: fc.record({
      primary: fc.option(
        fc.record({
          assetId: idArb('asset'),
          width: fc.option(fc.nat(4000), { nil: undefined }),
          height: fc.option(fc.nat(4000), { nil: undefined }),
        }),
        { nil: undefined },
      ),
    }),
  }),
})

const rawNodeArb = fc.oneof(
  sceneNodeArb,
  beatNodeArb,
  dialogueNodeArb,
  branchNodeArb,
  shotNodeArb,
  imageNodeArb,
)

/** 边：句柄从同名池取值——branch 的 option-<id> 可能指向不存在的选项
 * （悬空句柄脏数据），attach 恒为字面量 shots 端口。 */
const rawEdgeArb = fc
  .record({
    id: idArb('e'),
    source: idArb('n'),
    target: idArb('n'),
    kind: fc.constantFrom('sequence', 'branch', 'attach'),
    optionNo: fc.nat(4),
    order: fc.option(fc.nat(9), { nil: undefined }),
  })
  .map((e) => {
    // 运行态判别器（评审第三轮修复）：serializeProject 经 edgeKindOf 分类
    // （branch 看 type === 'branch'、attach 看 className），不读 data.kind——
    // 缺判别器的 branch 边会被序列化成 sequence，句柄归一化路径不被行使
    const edge: NodeSpecGen = { id: e.id, source: e.source, target: e.target }
    if (e.order !== undefined) edge.data = { order: e.order }
    if (e.kind === 'branch') {
      edge.type = 'branch'
      edge.sourceHandle = `option-opt${e.optionNo}`
    }
    if (e.kind === 'attach') {
      edge.className = 'pw-edge-attach'
      edge.sourceHandle = 'shots'
    }
    return edge
  })

const characterArb = fc.record({
  id: idArb('ch'),
  name: shortText,
  gradient: shortText,
  bio: fc.option(shortText, { nil: undefined }),
  avatarAssetId: fc.option(idArb('asset'), { nil: undefined }),
})
const locationArb = fc.record({
  id: idArb('loc'),
  name: shortText,
  note: fc.option(shortText, { nil: undefined }),
})
const propArb = fc.record({
  id: idArb('prop'),
  name: shortText,
  description: fc.option(shortText, { nil: undefined }),
})
const documentArb = fc.record({
  id: idArb('doc'),
  title: shortText,
  body: shortText,
  relatedIds: fc.array(
    fc.record({
      kind: fc.constantFrom('character', 'location'),
      id: idArb(''),
    }),
    { maxLength: 3 },
  ),
})
const assetArb = fc.record({
  id: idArb('asset'),
  relPath: fc.nat(4).map((n) => `assets/f${n}.png`),
  mime: fc.constantFrom('image/png', 'audio/mpeg'),
  source: fc.constantFrom('upload', 'generated'),
  createdAt: isoText,
})

/** 数组 → 键控桶：重复 id 折叠（末见胜）、空白键可能出现——两类均为
 * 归一化的可修复脏数据。 */
function keyedBy<T extends { id: string }>(rows: T[]): Record<string, T> {
  const out: Record<string, T> = {}
  for (const row of rows) out[row.id] = row
  return out
}

const contentArb = fc.record({
  nodes: fc.array(rawNodeArb, { maxLength: 6 }),
  edges: fc.array(rawEdgeArb, { maxLength: 6 }),
  characters: fc.array(characterArb, { maxLength: 4 }),
  locations: fc.array(locationArb, { maxLength: 4 }),
  props: fc.array(propArb, { maxLength: 4 }),
  documents: fc.array(documentArb, { maxLength: 4 }),
  assets: fc.array(assetArb, { maxLength: 4 }),
  name: shortText,
  createdAt: fc.option(isoText, { nil: undefined }),
  titles: fc.array(
    fc.record({
      // 键覆盖规范与非规范书写（评审第十一轮）：'01'/'1e0'/' 1' 等会被
      // 归一化删除或折叠，只生成规范键会让「保留脏键」的回归不可见
      key: fc.oneof(
        fc.nat(3).map(String),
        fc.constantFrom('01', '1e0', ' 1', '-1', '1.5'),
      ),
      // 标题覆盖纯空白串（去空白后为空的删除路径）
      title: fc.oneof(shortText, fc.constantFrom(' ', '  ', '\t')),
    }),
    { maxLength: 3 },
  ),
  viewport: fc.option(
    fc.record({
      x: finiteNumber,
      y: finiteNumber,
      zoom: fc.double({ min: 0.1, max: 4, noNaN: true }),
    }),
    { nil: undefined },
  ),
  aiRevision: fc.option(fc.nat(99), { nil: undefined }),
})

/** 生成 v1 原始信封：内容层生成 → serializeProject（与生产同款落盘形态）
 * → 结构级脏注入（异型容器/成员、坏元数据、扩展键）。 */
const dirtFlagsArb = fc.record({
  nullGraph: fc.boolean(),
  pushNullMembers: fc.boolean(),
  blankCharacterKey: fc.boolean(),
  collideBucketIds: fc.boolean(),
  badUpdatedAt: fc.boolean(),
  // 异型句柄（评审第十六轮）：targetHandle（任何边）与 sequence 边的
  // sourceHandle 均无法绑定匿名端口，§5 契约要求归一化剥离并告警
  alienEdgeHandles: fc.boolean(),
  graphExt: fc.option(extensionValue, { nil: undefined }),
  settingsExt: fc.option(extensionValue, { nil: undefined }),
  assetsExt: fc.option(extensionValue, { nil: undefined }),
})

type DirtFlags = ArbValue<typeof dirtFlagsArb>
type GeneratedContent = ArbValue<typeof contentArb>

/** v1 落盘信封的注入操作面（dirt 注入 helper 的最小结构）：nodes 允许
 * 注入字符串异型（nullGraph），edges 保持可 push。 */
interface EnvelopeDoc {
  graph: { nodes: unknown; edges: unknown[] } & Record<string, unknown>
  settings: Record<string, unknown> & { characters: Record<string, unknown> }
  assets: Record<string, unknown> & { byId: Record<string, unknown> }
  project: Record<string, unknown>
}

/** 键 id 碰撞注入（评审第二/三轮起，评审第十七轮自 v1Envelope 拆出）：
 * toDocSettings/keyedBy 会把生成数组里的重复 id 折叠成单键 Record——
 * 「异键 + 值内 id 冲突」到不了归一化边界。注入直达：每个已填充桶都加
 * 一条独立记录键持有源条目的克隆（值内 id 与源条目相同），全部设定桶与
 * 资产索引的键 id 一致性改写路径均被行使。克隆源取首个非空白键条目
 * （评审第十一轮）：非空白键经归一化原键存活，输出中可按 id 锚定源条目
 * 做同载荷比对；空白键源会被重发为不可预测的新键。全空白键桶不注入——
 * 空键重发本身已改写文档，repaired 保证不受影响。 */
function injectBucketCollisionClones(doc: EnvelopeDoc): void {
  const buckets: Record<string, unknown>[] = [
    doc.settings.characters,
    doc.settings.locations as Record<string, unknown>,
    doc.settings.props as Record<string, unknown>,
    doc.settings.documents as Record<string, unknown>,
    doc.assets.byId as Record<string, unknown>,
  ]
  for (const bucket of buckets) {
    const source = Object.keys(bucket).find((key) => key.trim())
    if (source !== undefined)
      bucket['dup-key'] = structuredClone(bucket[source])
  }
}

/** 异型句柄注入（评审第十六轮，第十七轮自 v1Envelope 拆出）：序列化正常
 * 产物不会携带这些形态，生成器侧构造到不了 parseProject；落在首个对象边
 * 与首个 sequence 边上。 */
function injectAlienEdgeHandles(doc: EnvelopeDoc): void {
  const edges = doc.graph.edges as unknown[]
  const anyEdge = edges.find(
    (e): e is Record<string, unknown> =>
      e !== null && typeof e === 'object' && !Array.isArray(e),
  )
  if (anyEdge !== undefined) anyEdge.targetHandle = 'alien-target'
  const seqEdge = edges.find(
    (e): e is Record<string, unknown> =>
      e !== null &&
      typeof e === 'object' &&
      (e as { data?: { kind?: unknown } }).data?.kind === 'sequence',
  )
  if (seqEdge !== undefined) seqEdge.sourceHandle = 'alien-anon'
}

function v1Envelope(
  c: GeneratedContent,
  dirt: DirtFlags,
): Record<string, unknown> {
  const content: ProjectContent = {
    name: c.name,
    createdAt: c.createdAt,
    nodes: c.nodes as never,
    edges: c.edges as never,
    settings: {
      characters: c.characters as never,
      locations: c.locations as never,
      props: c.props as never,
      documents: c.documents as never,
    },
    episodeTitles: Object.fromEntries(
      c.titles.map((t: { key: string; title: string }) => [t.key, t.title]),
    ),
    ...(c.viewport !== undefined ? { viewport: c.viewport } : {}),
    ...(c.aiRevision !== undefined ? { aiRevision: c.aiRevision } : {}),
    assets: { byId: keyedBy(c.assets) },
  }
  // 落盘产物整体克隆：parseProject 就地改写传入信封（输入所有权契约），
  // 克隆隔绝对生成器样例的污染，失败样例的打印保持输入原貌
  const doc = structuredClone(
    serializeProject(content, PROJECT_ID, NOW),
  ) as unknown as EnvelopeDoc
  if (dirt.nullGraph) {
    doc.graph.nodes = 'oops'
  }
  if (dirt.pushNullMembers) {
    doc.graph.edges.push(null, 42)
    doc.settings.characters['bad'] = null
  }
  if (dirt.blankCharacterKey && c.characters.length > 0) {
    const first = Object.keys(doc.settings.characters)[0]
    if (first !== undefined) {
      // 逐项克隆：真实磁盘 JSON 中两键持有独立拷贝（无共享引用），
      // 直接赋值会在信封内制造别名，走不进真实可达的输入空间
      doc.settings.characters[''] = structuredClone(
        doc.settings.characters[first],
      )
    }
  }
  if (dirt.collideBucketIds) injectBucketCollisionClones(doc)
  if (dirt.badUpdatedAt) doc.project.updatedAt = 'not-a-time'
  if (dirt.alienEdgeHandles) injectAlienEdgeHandles(doc)
  if (dirt.graphExt !== undefined) doc.graph.futureGraphField = dirt.graphExt
  if (dirt.settingsExt !== undefined)
    doc.settings.futureSettingsField = dirt.settingsExt
  if (dirt.assetsExt !== undefined)
    doc.assets.futureAssetsField = dirt.assetsExt
  return { schemaVersion: 1, ...doc }
}

/** v0 原始信封：旧扁平形态（数组桶、position 直挂、无 meta 包裹）。 */

/** 输出不变量（issue #232：身份唯一 + 活动边满足图规则 + 集标题契约）。 */
/** 碰撞注入存活断言（评审第十一轮）：collideBucketIds 向每个含非空白键
 * 的桶注入 dup-key 克隆（值内 id 与源条目冲突）——契约是记录键为权威 id、
 * 值内 id 改写为 dup-key、条目与其余载荷存活；删除克隆或另发任意身份的
 * 冲突消解不再放行。实体形状判定是条目本地的（normalizeSettings），源条目
 * 被隔离时同载荷克隆同被隔离。 */
function assertCollisionClones(
  c: GeneratedContent,
  content: ProjectContent,
): void {
  const arrayBuckets: Array<
    [string, Array<{ id: string }>, Array<{ id: string }>]
  > = [
    ['角色', content.settings.characters, c.characters],
    ['地点', content.settings.locations, c.locations],
    ['道具', content.settings.props ?? [], c.props],
    ['设定文档', content.settings.documents ?? [], c.documents],
  ]
  for (const [label, outBucket, genBucket] of arrayBuckets) {
    const sourceId = genBucket.find((e) => e.id.trim())?.id
    if (sourceId === undefined) continue
    const source = outBucket.find((e) => e.id === sourceId)
    const dup = outBucket.find((e) => e.id === 'dup-key')
    if (source === undefined) {
      expect(
        dup,
        `${label}桶：源条目被形状隔离时同载荷碰撞克隆同被隔离`,
      ).toBeUndefined()
      continue
    }
    expect(
      dup,
      `${label}桶：碰撞克隆随权威键 dup-key 存活且载荷与源条目一致`,
    ).toEqual({ ...source, id: 'dup-key' })
  }
  const assetSourceId = c.assets.find((a) => a.id.trim())?.id
  if (assetSourceId === undefined) return
  const byId = content.assets?.byId ?? {}
  const source = byId[assetSourceId]
  const dup = byId['dup-key']
  if (source === undefined) {
    expect(
      dup,
      '资产索引：源条目被形状隔离时同载荷碰撞克隆同被隔离',
    ).toBeUndefined()
    return
  }
  expect(
    dup,
    '资产索引：碰撞克隆随权威键 dup-key 存活且载荷与源条目一致',
  ).toEqual({ ...source, id: 'dup-key' })
}

describe('归一化不变量的生成式验证（issue #232）：v1 脏信封不变量与幂等', () => {
  it('任意脏 v1 信封：解析不抛错且输出满足身份/边/集标题不变量', () => {
    fc.assert(
      fc.property(contentArb, dirtFlagsArb, (c, dirt) => {
        const doc = v1Envelope(c, dirt)
        const round = parseProject(doc)
        assertOutputInvariants(round.content)
        // 碰撞克隆存活（评审第十一轮）：注入只落在含非空白键的桶
        if (dirt.collideBucketIds) assertCollisionClones(c, round.content)
        // 保证脏注入的修复信号（评审第七/九轮）：这些注入必然改写文档，
        // repaired=false 会让调用方不回写、脏数据每次加载都重复修复；
        // 键级注入按「至少一个可注入的已填充容器」人口感知判定——全空白
        // 键桶虽不接收碰撞克隆，空键重发同样必然改写文档，条件不受影响
        const bucketPopulated =
          c.characters.length > 0 ||
          c.locations.length > 0 ||
          c.props.length > 0 ||
          c.documents.length > 0 ||
          c.assets.length > 0
        if (
          dirt.nullGraph ||
          dirt.pushNullMembers ||
          dirt.badUpdatedAt ||
          (dirt.alienEdgeHandles && c.edges.length > 0) ||
          (dirt.blankCharacterKey && c.characters.length > 0) ||
          (dirt.collideBucketIds && bucketPopulated)
        ) {
          expect(round.repaired, '保证脏注入必须报告 repaired').toBe(true)
        }
      }),
    )
  })
  it('规范化幂等：修复产物落盘后再解析不再修复，内容到达不动点', () => {
    fc.assert(
      fc.property(contentArb, dirtFlagsArb, (c, dirt) => {
        const round1 = parseProject(v1Envelope(c, dirt))
        const round2 = parseProject(
          serializeProject(round1.content, PROJECT_ID, NOW),
        )
        expect(round2.migrated, '第二轮不再迁移').toBe(false)
        expect(round2.repaired, '第二轮不再修复').toBe(false)
        const round3 = parseProject(
          serializeProject(round2.content, PROJECT_ID, NOW),
        )
        expect(round3.migrated).toBe(false)
        expect(round3.repaired).toBe(false)
        expect(round3.content, '内容到达不动点').toEqual(round2.content)
      }),
    )
  })
})

describe('归一化不变量的生成式验证（issue #232）：v1 扩展字段保全', () => {
  it('容器级扩展字段按契约保留：未知键经解析进 content、再序列化原样落盘', () => {
    fc.assert(
      fc.property(contentArb, dirtFlagsArb, (c, dirt) => {
        const doc = v1Envelope(c, dirt)
        const round = parseProject(doc)
        const again = serializeProject(
          round.content,
          PROJECT_ID,
          NOW,
        ) as unknown as {
          graph: Record<string, unknown>
          settings: Record<string, unknown>
          assets: Record<string, unknown>
        }
        // 扩展键与脏标记键配对成组（评审修复：落盘字段名与 dirt 键不同名，
        // 旧写法 dirt[field] 的查找恒为 undefined，断言从未执行——空转的性质）
        const extensionPairs = [
          {
            injected: dirt.graphExt,
            field: 'futureGraphField',
            spot: again.graph,
            extensions: round.content.graphExtensions,
          },
          {
            injected: dirt.settingsExt,
            field: 'futureSettingsField',
            spot: again.settings,
            extensions: round.content.settingsExtensions,
          },
          {
            injected: dirt.assetsExt,
            field: 'futureAssetsField',
            spot: again.assets,
            extensions: round.content.assetsExtensions,
          },
        ] as const
        for (const { injected, field, spot, extensions } of extensionPairs) {
          if (injected === undefined) continue
          expect(extensions?.[field], `扩展键 ${field} 经解析保留`).toEqual(
            injected,
          )
          expect(spot[field], `扩展键 ${field} 再序列化原样落盘`).toEqual(
            injected,
          )
        }
      }),
    )
  })
})

/** 干净生成器（评审第四轮：结构不变量放行「静默清空」回归，需要保全
 * 预言机）——身份确定性唯一（n0..、ch0..），下标引用保证端点/句柄落在
 * 真实节点与选项，边只从低下标指向高下标（DAG 前置）。合法记录与其
 * 内容经解析-序列化必须存活。 */
const cleanPayloadArb = fc.record({
  sceneNames: fc.array(preservedText, { maxLength: 4 }),
  dialogueTexts: fc.array(preservedText, { maxLength: 2 }),
  branchOptionLabels: fc.array(fc.array(preservedText, { maxLength: 3 }), {
    maxLength: 2,
  }),
  assetRelPaths: fc.array(preservedText, { minLength: 1, maxLength: 3 }),
  // 引用目标桶保底非空（评审第九轮：跨记录引用需确定存在的目标）
  characterNames: fc.array(preservedText, { minLength: 1, maxLength: 3 }),
  locationNames: fc.array(preservedText, { minLength: 1, maxLength: 3 }),
  propNames: fc.array(preservedText, { maxLength: 3 }),
  documentSpecs: fc.array(
    fc.record({
      title: preservedText,
      withLocation: fc.boolean(),
    }),
    { maxLength: 3 },
  ),
  titles: fc.array(
    fc.record({
      episode: fc.integer({ min: 1, max: 5 }),
      title: preservedText,
    }),
    { maxLength: 3 },
  ),
  beatTones: fc.array(preservedText, { maxLength: 2 }),
  shotPictures: fc.array(preservedText, { maxLength: 2 }),
  imagePrompts: fc.array(preservedText, { maxLength: 2 }),
  flowPairs: fc.array(fc.record({ from: fc.nat(9), to: fc.nat(9) }), {
    maxLength: 4,
  }),
  branchEdgeSpecs: fc.array(
    fc.record({ from: fc.nat(9), to: fc.nat(9), optionIdx: fc.nat(2) }),
    { maxLength: 2 },
  ),
  // 组序布局（评审第十四轮）：branch 首位时 from<to 永远到不了 branch 目标
  // ——运行态端点规则允许 branch 作 sequence/branch 边目标；布局交替后
  // 两种排列的并集覆盖 branch 入向（beat/scene→branch）与出向全目标
  branchLate: fc.boolean(),
  // 会话级元数据（评审第十七轮）：description/createdAt/viewport/aiRevision
  // 的合法值——此前只在脏信封生成而不做保全比对，静默丢弃不可见；合法域
  // 依生产契约（viewport 有限数 + zoom>0、aiRevision 非负安全整数）
  description: fc.option(shortText, { nil: undefined }),
  metaCreatedAt: fc.option(isoText, { nil: undefined }),
  viewport: fc.option(
    fc.record({
      x: finiteNumber,
      y: finiteNumber,
      zoom: fc.double({ min: 0.1, max: 4, noNaN: true }),
    }),
    { nil: undefined },
  ),
  aiRevision: fc.option(fc.nat(9), { nil: undefined }),
  attachSpecs: fc.array(
    fc.record({ sceneIdx: fc.nat(3), shotIdx: fc.nat(1) }),
    { maxLength: 2 },
  ),
})

/** 干净内容的组装（评审第四轮保全预言机）：确定性唯一身份 + 下标
 * 引用落位 + from<to 的 DAG 前置；返回会话内容与集标题预期。 */
/** 干净节点组装（保全预言机）：确定性唯一 id；数组序是边组装（from<to
 * 的 DAG 前置）的寻址基准，不得随意变更。组序两态交替（评审第十四轮）：
 * branch 首位（branch/beat/scene/dialogue）覆盖 branch 出向全目标；
 * branch 后置（beat/scene/branch/dialogue）覆盖 branch 入向（beat/scene
 * →branch 的 sequence 边）与组内 branch→branch——运行态端点规则
 * （connectionEndpointIssue）允许 branch 作目标、仅禁其作 sequence 源；
 * 媒体面（shot/image）恒殿后。 */
function assembleCleanNodes(
  payload: ArbValue<typeof cleanPayloadArb>,
): Array<Record<string, unknown>> {
  return [
    ...assembleNarrativeCleanNodes(payload),
    ...assembleMediaCleanNodes(payload),
  ]
}

/** 单组节点构造（assembleNarrativeCleanNodes 的分组成员，按组序回调）。 */
function pushNarrativeGroup(
  group: 'branch' | 'beat' | 'scene' | 'dialogue',
  payload: ArbValue<typeof cleanPayloadArb>,
  nodes: Array<Record<string, unknown>>,
): void {
  if (group === 'branch') {
    payload.branchOptionLabels.forEach((labels, i) => {
      if (labels.length === 0) return
      nodes.push({
        id: `b${i}`,
        type: 'branch',
        position: { x: 0, y: 0 },
        data: {
          prompt: `问${i}`,
          options: labels.map((label, j) => ({ id: `opt${i}-${j}`, label })),
        },
      })
    })
    return
  }
  if (group === 'beat') {
    payload.beatTones.forEach((tone, i) =>
      nodes.push({
        id: `t${i}`,
        type: 'beat',
        position: { x: 0, y: 0 },
        data: { name: `节拍${i}`, tone },
      }),
    )
    return
  }
  if (group === 'scene') {
    payload.sceneNames.forEach((name, i) =>
      nodes.push({
        id: `n${i}`,
        type: 'scene',
        position: { x: 0, y: 0 },
        data: {
          name,
          sceneNo: 1,
          interior: true,
          synopsis: '',
          // 关联引用（评审第九轮）：ch0/loc0 由保底非空的角色/地点桶供给
          locationId: 'loc0',
          characterIds: ['ch0'],
          time: 't',
          weather: 'w',
        },
      }),
    )
    return
  }
  payload.dialogueTexts.forEach((text, i) =>
    nodes.push({
      id: `d${i}`,
      type: 'dialogue',
      position: { x: 0, y: 0 },
      data: {
        name: `对白${i}`,
        lines: [{ id: `l${i}`, kind: 'line', text, speaker: 'ch0' }],
      },
    }),
  )
}

/** 干净节点组装 · 叙事面：组序按 branchLate 两态排列（见 assembleCleanNodes
 * 文档），确定性唯一 id。 */
function assembleNarrativeCleanNodes(
  payload: ArbValue<typeof cleanPayloadArb>,
): Array<Record<string, unknown>> {
  const groups = payload.branchLate
    ? (['beat', 'scene', 'branch', 'dialogue'] as const)
    : (['branch', 'beat', 'scene', 'dialogue'] as const)
  const nodes: Array<Record<string, unknown>> = []
  for (const group of groups) pushNarrativeGroup(group, payload, nodes)
  return nodes
}

/** 干净节点组装 · 媒体面：shot/image，确定性唯一 id。 */
function assembleMediaCleanNodes(
  payload: ArbValue<typeof cleanPayloadArb>,
): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = []
  payload.shotPictures.forEach((picture, i) =>
    nodes.push({
      id: `sh${i}`,
      type: 'shot',
      position: { x: 0, y: 0 },
      data: {
        shotNo: i + 1,
        size: '中景',
        picture,
        prompt: `分镜${i}`,
        // 引用位（评审第九轮）：a0 由保底非空的资产桶供给（image/*）
        refs: [{ id: `r${i}`, kind: 'character', assetId: 'a0' }],
      },
    }),
  )
  payload.imagePrompts.forEach((prompt, i) =>
    nodes.push({
      id: `img${i}`,
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        prompt,
        model: 'm',
        size: 's',
        outputs: { primary: { assetId: 'a0' } },
      },
    }),
  )
  return nodes
}

/** 干净边组装：from<to 的统一前向序（含 branch 边，评审第五轮——两段
 * branch 边可闭合回路，环隔离会让预期失配）；端点类型约束外的下标
 * 碰撞形态不计入保全预期。 */
function assembleCleanEdges(
  payload: ArbValue<typeof cleanPayloadArb>,
  nodes: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  // 剧情流端点白名单（§4.2/§13）：shot/image 不参与横向剧情流
  const flowEndpoint = (t: unknown): boolean =>
    t === 'scene' || t === 'dialogue' || t === 'beat'
  // 流边目标（评审第十四轮）：branch 可作 sequence/branch 边目标（运行态
  // connectionEndpointIssue 仅禁其作 sequence 源），组内后位 branch 亦可
  const flowTarget = (t: unknown): boolean => flowEndpoint(t) || t === 'branch'
  const edges: Array<Record<string, unknown>> = []
  let edgeNo = 0
  for (const pair of payload.flowPairs) {
    const src = nodes[pair.from]
    const dst = nodes[pair.to]
    if (src === undefined || dst === undefined || pair.from >= pair.to) continue
    // 源取剧情流白名单任一类型（评审第十三轮：此前只认 scene，dialogue/
    // beat 的匿名输出边从未生成）——branch 无匿名端口，不在白名单内
    if (!flowEndpoint(src.type) || !flowTarget(dst.type)) continue
    edges.push({ id: `e${edgeNo++}`, source: src.id, target: dst.id })
  }
  for (const spec of payload.branchEdgeSpecs) {
    const src = nodes[spec.from]
    const dst = nodes[spec.to]
    const options =
      src?.type === 'branch'
        ? (src.data as { options: Array<{ id: string }> }).options
        : []
    if (src?.type !== 'branch' || dst === undefined) continue
    if (spec.from >= spec.to || options.length <= spec.optionIdx) continue
    if (!flowTarget(dst.type)) continue
    edges.push({
      id: `e${edgeNo++}`,
      source: src.id,
      target: dst.id,
      sourceHandle: `option-${options[spec.optionIdx]?.id}`,
      type: 'branch',
    })
  }
  // attach（scene→shots 端口→shot）：同 shot 至多一条（宿主唯一），按
  // shot 目标去重首见胜
  const attachedShots = new Set<string>()
  for (const spec of payload.attachSpecs) {
    const src = nodes.find(
      (n) => n.id === `n${spec.sceneIdx}` && n.type === 'scene',
    )
    const dst = nodes.find(
      (n) => n.id === `sh${spec.shotIdx}` && n.type === 'shot',
    )
    if (src === undefined || dst === undefined) continue
    if (attachedShots.has(dst.id as string)) continue
    attachedShots.add(dst.id as string)
    edges.push({
      id: `e${edgeNo++}`,
      source: src.id,
      target: dst.id,
      sourceHandle: 'shots',
      className: 'pw-edge-attach',
    })
  }
  return edges
}

function assembleCleanContent(payload: ArbValue<typeof cleanPayloadArb>): {
  content: ProjectContent
  expectedTitles: Record<string, string>
} {
  const nodes = assembleCleanNodes(payload)
  const edges = assembleCleanEdges(payload, nodes)
  const assets = Object.fromEntries(
    payload.assetRelPaths.map((rel, i) => [
      `a${i}`,
      {
        id: `a${i}`,
        relPath: `assets/${rel}`,
        mime: 'image/png',
        source: 'upload' as const,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
  )
  const expectedTitles = Object.fromEntries(
    new Map(payload.titles.map((t) => [String(t.episode), t.title])),
  )
  return {
    content: {
      name: '保全',
      ...(payload.description !== undefined
        ? { description: payload.description }
        : {}),
      ...(payload.metaCreatedAt !== undefined
        ? { createdAt: payload.metaCreatedAt }
        : {}),
      nodes: nodes as never,
      edges: edges as never,
      settings: {
        characters: payload.characterNames.map((name, i) => ({
          id: `ch${i}`,
          name,
          gradient: 'g',
        })),
        locations: payload.locationNames.map((name, i) => ({
          id: `loc${i}`,
          name,
        })),
        props: payload.propNames.map((name, i) => ({
          id: `prop${i}`,
          name,
        })),
        documents: payload.documentSpecs.map((doc, i) => ({
          id: `doc${i}`,
          title: doc.title,
          body: '正文',
          // 文档关系（评审第十一轮）：ch0 恒在、loc0 随生成标志——目标由
          // 保底非桶供给；恒空数组会让「清空全部合法关系」的回归不可见
          relatedIds: [
            { kind: 'character' as const, id: 'ch0' },
            ...(doc.withLocation
              ? [{ kind: 'location' as const, id: 'loc0' }]
              : []),
          ],
        })),
      },
      episodeTitles: expectedTitles,
      ...(payload.viewport !== undefined ? { viewport: payload.viewport } : {}),
      ...(payload.aiRevision !== undefined
        ? { aiRevision: payload.aiRevision }
        : {}),
      assets: { byId: assets },
    },
    expectedTitles,
  }
}

/** 保全断言 · 会话级元数据面（评审第十七轮）：description/createdAt/
 * viewport/aiRevision 的语义保全——description 逐字、createdAt 缺省时
 * 落盘补盖序列化时钟（NOW）、viewport 深比对、aiRevision 按「缺省 = 0」
 * 等价类比对（0 不落盘是 §12.2 契约，非丢失）。 */
function assertMetaPreserved(
  payload: ArbValue<typeof cleanPayloadArb>,
  out: ProjectContent,
): void {
  expect(out.description ?? '', '项目描述保全').toBe(payload.description ?? '')
  expect(out.createdAt, '创建时间保全（缺省补盖序列化时钟）').toBe(
    payload.metaCreatedAt ?? NOW.toISOString(),
  )
  expect(out.viewport ?? undefined, '视口保全').toEqual(
    payload.viewport ?? undefined,
  )
  expect(out.aiRevision ?? 0, 'AI 批次计数语义保全（缺省 = 0 等价类）').toBe(
    payload.aiRevision ?? 0,
  )
}

/** 保全断言 · 节点面（评审第十五轮重写为完整记录比对）：以夹具组装
 * 函数本身为预期（不二次誊写字段清单），按稳定 id 逐节点比对类型、
 * 布局与夹具填充的每一个 data 字段（含 lines/options/refs/outputs 整个
 * 子对象）——此前只比各类型选定的投影，sceneNo/interior/time/weather/
 * synopsis、对白名、branch prompt、shot 编号/景别/prompt、image 模型/
 * 尺寸/产物被静默清空仍放行。 */
function assertNodesPreserved(
  payload: ArbValue<typeof cleanPayloadArb>,
  out: ProjectContent,
): void {
  const wantNodes = assembleCleanNodes(payload)
  expect(out.nodes.map((n) => n.id).sort(), '节点全部存活').toEqual(
    wantNodes.map((n) => n.id as string).sort(),
  )
  const byId = new Map(out.nodes.map((n) => [n.id, n]))
  for (const want of wantNodes) {
    const node = byId.get(want.id as string)
    expect(node?.type, `节点 ${want.id} 类型保全`).toBe(want.type)
    expect(node?.position, `节点 ${want.id} 布局保全`).toEqual(want.position)
    const wantData = want.data as Record<string, unknown>
    for (const key of Object.keys(wantData)) {
      expect(
        (node?.data as Record<string, unknown> | undefined)?.[key],
        `节点 ${want.id} 的 data.${key} 完整保全`,
      ).toEqual(wantData[key])
    }
  }
  expect(out.name, '项目名保全').toBe('保全')
}

/** 保全断言 · 引用面（评审第九轮）：跨记录引用逐条存活。 */
function assertReferencesPreserved(out: ProjectContent): void {
  expect(
    out.nodes
      .filter((n) => n.type === 'scene')
      .every(
        (n) =>
          n.type === 'scene' &&
          n.data.locationId === 'loc0' &&
          n.data.characterIds.includes('ch0'),
      ),
    '场景关联引用保全',
  ).toBe(true)
  expect(
    out.nodes
      .filter((n) => n.type === 'dialogue')
      .every(
        (n) =>
          n.type === 'dialogue' &&
          n.data.lines.every((l) => l.speaker === 'ch0'),
      ),
    '对白说话人引用保全',
  ).toBe(true)
  expect(
    out.nodes
      .filter((n) => n.type === 'shot')
      .every(
        (n) => n.type === 'shot' && n.data.refs.some((r) => r.assetId === 'a0'),
      ),
    '分镜引用位保全',
  ).toBe(true)
  expect(
    out.nodes
      .filter((n) => n.type === 'image')
      .every(
        (n) => n.type === 'image' && n.data.outputs.primary?.assetId === 'a0',
      ),
    '图片产物链接保全',
  ).toBe(true)
}

/** 保全断言 · 嵌套身份面（评审第十轮）：对白行/分支选项/分镜引用位的
 * 合法 id 按所属节点逐组有序比对——只比文本/标签会放行「同载荷换 id」
 * 与同组 id 互换，而这些嵌套 id 驱动列表 reconcile 与 branch 句柄引用。 */
function assertNestedIdsPreserved(
  payload: ArbValue<typeof cleanPayloadArb>,
  out: ProjectContent,
): void {
  const actual: Array<[string, string[]]> = []
  for (const n of out.nodes) {
    if (n.type === 'dialogue')
      actual.push([n.id, n.data.lines.map((l) => l.id)])
    else if (n.type === 'branch')
      actual.push([n.id, n.data.options.map((o) => o.id)])
    else if (n.type === 'shot')
      actual.push([n.id, n.data.refs.map((r) => r.id)])
  }
  const expected: Array<[string, string[]]> = [
    ...payload.dialogueTexts.map((_, i): [string, string[]] => [
      `d${i}`,
      [`l${i}`],
    ]),
    ...payload.branchOptionLabels.flatMap(
      (labels, i): Array<[string, string[]]> =>
        labels.length > 0
          ? [[`b${i}`, labels.map((_, j) => `opt${i}-${j}`)]]
          : [],
    ),
    ...payload.shotPictures.map((_, i): [string, string[]] => [
      `sh${i}`,
      [`r${i}`],
    ]),
  ]
  expect(
    Object.fromEntries(actual),
    '嵌套身份（对白行/分支选项/分镜引用位 id）逐节点保全',
  ).toEqual(Object.fromEntries(expected))
}

/** 保全断言 · 设定与资产面（评审第十五轮改为全记录比对）：四桶逐条
 * 与夹具完整记录 deep-equal——只比 id:名称投影会放行 body/gradient 被
 * 清空（gradient 为角色必填渲染字段）；文档全记录比对收编评审第十一轮
 * 的 relatedIds 关系断言（{kind,id} 对含于完整记录）。资产全记录与集
 * 标题维持既有比对。 */
function assertSettingsPreserved(
  payload: ArbValue<typeof cleanPayloadArb>,
  out: ProjectContent,
  expectedTitles: Record<string, string>,
): void {
  expect(out.settings.characters, '角色全记录保全（含 gradient）').toEqual(
    payload.characterNames.map((name, i) => ({
      id: `ch${i}`,
      name,
      gradient: 'g',
    })),
  )
  expect(out.settings.locations, '地点全记录保全').toEqual(
    payload.locationNames.map((name, i) => ({ id: `loc${i}`, name })),
  )
  expect(out.settings.props ?? [], '道具全记录保全').toEqual(
    payload.propNames.map((name, i) => ({ id: `prop${i}`, name })),
  )
  expect(
    out.settings.documents ?? [],
    '设定文档全记录保全（含 body 与 relatedIds）',
  ).toEqual(
    payload.documentSpecs.map((doc, i) => ({
      id: `doc${i}`,
      title: doc.title,
      body: '正文',
      relatedIds: [
        { kind: 'character', id: 'ch0' },
        ...(doc.withLocation ? [{ kind: 'location', id: 'loc0' }] : []),
      ],
    })),
  )
  // 资产全记录比对（评审第八轮：只比键会放行元数据清空/损坏）
  const expectedAssets = Object.fromEntries(
    payload.assetRelPaths.map((rel, i) => [
      `a${i}`,
      {
        id: `a${i}`,
        relPath: `assets/${rel}`,
        mime: 'image/png',
        source: 'upload',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
  )
  expect(out.assets?.byId, '资产全记录保全').toEqual(expectedAssets)
  expect(out.episodeTitles, '集标题保全').toEqual(expectedTitles)
}

/** 保全断言 · 边面（评审第九轮：稳定 id + 元组联合比对）：幸存边按
 * `${id}:${source}→${target}:${handle}` 全量比对——id 被重发（后续选择/
 * 删除/命令引用随之失效）不再放行；预期按元组去重首见胜。 */
function assertEdgesPreserved(
  out: ProjectContent,
  edgeKeys: string[],
  attachKeys: string[],
): void {
  const outEdges = out.edges.map(
    (e) => `${e.id}:${e.source}→${e.target}:${e.sourceHandle ?? ''}`,
  )
  const flowEdges = outEdges.filter(
    (key) =>
      !key.includes(':') === false &&
      edgeKindOf(
        out.edges.find(
          (e) =>
            `${e.id}:${e.source}→${e.target}:${e.sourceHandle ?? ''}` === key,
        ) ?? {},
      ) !== 'attach',
  )
  expect(flowEdges.sort(), '有效边稳定存活').toEqual(edgeKeys.sort())
  const attachEdges = outEdges.filter(
    (key) =>
      edgeKindOf(
        out.edges.find(
          (e) =>
            `${e.id}:${e.source}→${e.target}:${e.sourceHandle ?? ''}` === key,
        ) ?? {},
      ) === 'attach',
  )
  expect(attachEdges.sort(), 'attach 下挂边稳定存活').toEqual(attachKeys.sort())
}

describe('归一化不变量的生成式验证（issue #232）：有效内容保全', () => {
  it('合法生成记录经归一化全部存活：节点/设定/资产/集标题/有效边不丢', () => {
    fc.assert(
      fc.property(cleanPayloadArb, (payload) => {
        const { content, expectedTitles } = assembleCleanContent(payload)
        // 经 serializeProject 构造合法 v1 信封（与生产同款落盘路径）；
        // 手工拼 v0 扁平 data 塞进 v1 信封会被嵌套容器守卫正确隔离
        const doc = serializeProject(content, PROJECT_ID, NOW) as unknown as {
          graph: { edges: Array<Record<string, unknown>> }
        }
        // 异型句柄注入（评审第十六轮）：保全性质的边按构造必然幸存，
        // §5 剥离契约在此才有咬合面——脏信封性质里的同类注入几乎总随
        // 孤儿边隔离到不了输出（实测 100 样本幸存边恒 0）。注入全部边：
        // targetHandle（任何种类）与 sequence 边的 sourceHandle，断言经
        // 剥离后边仍全部存活（§5：剥离不隔离）且句柄不残留（shared 逐边
        // 断言 + 预期键的 handle 位）
        const alienInjected = content.edges.length > 0
        if (alienInjected) {
          for (const e of doc.graph.edges) {
            e.targetHandle = 'alien-target'
            if ((e.data as { kind?: unknown } | undefined)?.kind === 'sequence')
              e.sourceHandle = 'alien-anon'
          }
        }
        const round1 = parseProject(doc)
        if (alienInjected)
          expect(round1.repaired, '异型句柄注入必须报告 repaired').toBe(true)
        assertNodesPreserved(payload, round1.content)
        assertMetaPreserved(payload, round1.content)
        assertReferencesPreserved(round1.content)
        assertNestedIdsPreserved(payload, round1.content)
        assertSettingsPreserved(payload, round1.content, expectedTitles)
        // 预期键 `${id}:${source}→${target}:${handle}`，按元组去重首见胜
        // xyflow Edge 的 sourceHandle 显式含 undefined（库形状，issue #231）
        const tupleOf = (e: {
          source: string
          target: string
          sourceHandle?: string | null | undefined
        }) => `${e.source}→${e.target}:${e.sourceHandle ?? ''}`
        const firstEdgeByTuple = new Map<string, string>()
        for (const e of content.edges) {
          const tuple = tupleOf(e)
          const key = `${e.id}:${tuple}`
          if (!firstEdgeByTuple.has(tuple)) firstEdgeByTuple.set(tuple, key)
        }
        const allKeys = [...firstEdgeByTuple.values()]
        const attachTuples = new Set(
          content.edges
            .filter(
              (e) =>
                (e as { className?: string }).className === 'pw-edge-attach',
            )
            .map((e) => tupleOf(e)),
        )
        const flowKeys = allKeys.filter(
          (key) => !attachTuples.has(key.slice(key.indexOf(':') + 1)),
        )
        const attachKeys = allKeys.filter((key) =>
          attachTuples.has(key.slice(key.indexOf(':') + 1)),
        )
        assertEdgesPreserved(round1.content, flowKeys, attachKeys)
      }),
    )
  })
})
