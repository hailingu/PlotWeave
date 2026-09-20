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
import { CURRENT_SCHEMA_VERSION } from './document'
import type { ProjectContent } from './content'
import { NOW } from './convertFixtures'
import { edgeKindOf, SCENE_SHOT_HANDLE } from '../editor/graphRules'

const PROJECT_ID = 'p-prop'

beforeAll(() => {
  const seedEnv = process.env.PROPERTY_SEED
  const runsEnv = process.env.PROPERTY_RUNS
  fc.configureGlobal({
    numRuns: runsEnv !== undefined ? Number(runsEnv) : 100,
    ...(seedEnv !== undefined ? { seed: Number(seedEnv) } : {}),
  })
})

/** 小池身份（0–4）：天然产生重复/碰撞（归一化重发路径的脏输入源），
 * 尾号 9（约 1/10）映射为空白串（空键重发路径）。 */
const idArb = (prefix: string) =>
  fc.nat(9).map((n) => (n === 9 ? '' : `${prefix}${n}`))

const shortText = fc.string({ minLength: 0, maxLength: 8 })
const finiteNumber = fc.double({ min: -1000, max: 1000, noNaN: true })
const isoText = fc
  .nat(27)
  .map((day) => `2026-01-${String(day + 1).padStart(2, '0')}T00:00:00.000Z`)

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
  titles: fc.array(fc.record({ episode: fc.nat(3), title: shortText }), {
    maxLength: 3,
  }),
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
  graphExt: fc.option(extensionValue, { nil: undefined }),
  settingsExt: fc.option(extensionValue, { nil: undefined }),
  assetsExt: fc.option(extensionValue, { nil: undefined }),
})

/** 任意生成器的取值类型推断（fc.Arbitrary<T> 的条件展开）。 */
type ArbValue<A> = A extends fc.Arbitrary<infer T> ? T : never
type DirtFlags = ArbValue<typeof dirtFlagsArb>
type GeneratedContent = ArbValue<typeof contentArb>

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
      c.titles.map((t: { episode: number; title: string }) => [
        String(t.episode),
        t.title,
      ]),
    ),
    ...(c.viewport !== undefined ? { viewport: c.viewport } : {}),
    ...(c.aiRevision !== undefined ? { aiRevision: c.aiRevision } : {}),
    assets: { byId: keyedBy(c.assets) },
  }
  // 落盘产物整体克隆：parseProject 就地改写传入信封（输入所有权契约），
  // 克隆隔绝对生成器样例的污染，失败样例的打印保持输入原貌
  const doc = structuredClone(
    serializeProject(content, PROJECT_ID, NOW),
  ) as unknown as {
    // nodes 允许注入字符串异型（nullGraph 脏注入），edges 保持可 push
    graph: { nodes: unknown; edges: unknown[] } & Record<string, unknown>
    settings: Record<string, unknown> & {
      characters: Record<string, unknown>
    }
    assets: Record<string, unknown> & { byId: Record<string, unknown> }
    project: Record<string, unknown>
  }
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
  if (dirt.collideBucketIds) {
    // 评审修复（第二轮/第三轮）：toDocSettings/keyedBy 会把生成数组里的
    // 重复 id 折叠成单键 Record——「异键 + 值内 id 冲突」到不了归一化边界。
    // 注入直达：每个已填充桶都加一条独立记录键持有首条目的克隆（值内 id
    // 与原条目相同），全部设定桶与资产索引的键 id 一致性改写路径均被行使
    const buckets: Record<string, unknown>[] = [
      doc.settings.characters,
      doc.settings.locations as Record<string, unknown>,
      doc.settings.props as Record<string, unknown>,
      doc.settings.documents as Record<string, unknown>,
      doc.assets.byId as Record<string, unknown>,
    ]
    for (const bucket of buckets) {
      const first = Object.keys(bucket)[0]
      if (first !== undefined)
        bucket['dup-key'] = structuredClone(bucket[first])
    }
  }
  if (dirt.badUpdatedAt) doc.project.updatedAt = 'not-a-time'
  if (dirt.graphExt !== undefined) doc.graph.futureGraphField = dirt.graphExt
  if (dirt.settingsExt !== undefined)
    doc.settings.futureSettingsField = dirt.settingsExt
  if (dirt.assetsExt !== undefined)
    doc.assets.futureAssetsField = dirt.assetsExt
  return { schemaVersion: 1, ...doc }
}

/** v0 原始信封：旧扁平形态（数组桶、position 直挂、无 meta 包裹）。 */
/** v0 branch 节点规格：属性化生成后由性质以固定 id `br0` 组装（保证
 * 迁移目标存在），选项 id 唯一化（迁移路径的干净前置）。 */
const v0BranchSpecArb = fc.record({
  prompt: shortText,
  optionLabels: fc.array(shortText, { maxLength: 3 }),
})
const v0SceneArb = fc.record({
  id: idArb('n'),
  type: fc.constant('scene'),
  position: fc.record({ x: finiteNumber, y: finiteNumber }),
  data: fc.record({
    name: shortText,
    sceneNo: fc.nat(3),
    interior: fc.boolean(),
    synopsis: shortText,
  }),
})
/** 旧版 option-N 下标句柄边（§11.1 迁移链的迁移目标）：optionIdx 取值
 * 覆盖在界与越界（越界句柄按孤儿边隔离，属允许的修复）。 */
const v0BranchEdgeArb = fc.record({
  id: idArb('be'),
  targetIdx: fc.nat(4),
  optionIdx: fc.nat(3),
})
const v0EnvelopeArb = fc.record({
  branch: v0BranchSpecArb,
  scenes: fc.array(v0SceneArb, { maxLength: 4 }),
  flowEdgeSpecs: fc.array(
    fc.record({ sourceIdx: fc.nat(4), targetIdx: fc.nat(4) }),
    { maxLength: 4 },
  ),
  branchEdges: fc.array(v0BranchEdgeArb, { maxLength: 3 }),
  characters: fc.array(characterArb, { maxLength: 3 }),
})

/** 输出不变量（issue #232：身份唯一 + 活动边满足图规则 + 集标题契约）。 */
/** 身份唯一不变量（issue #232）：全部生成身份域非空且唯一 + 资产索引
 * 键与值内 id 一致。 */
function assertIdentityInvariants(content: ProjectContent): void {
  const domains: Array<[string, string[]]> = [
    ['节点', content.nodes.map((n) => n.id)],
    ['边', content.edges.map((e) => e.id)],
    ['角色', content.settings.characters.map((e) => e.id)],
    ['地点', content.settings.locations.map((e) => e.id)],
    ['道具', (content.settings.props ?? []).map((e) => e.id)],
    ['设定文档', (content.settings.documents ?? []).map((e) => e.id)],
    ['资产索引', Object.values(content.assets?.byId ?? {}).map((a) => a.id)],
  ]
  for (const [label, ids] of domains) {
    expect(
      ids.every((id) => id !== ''),
      `${label} id 非空`,
    ).toBe(true)
    expect(new Set(ids).size, `${label} id 唯一`).toBe(ids.length)
  }
  // 资产记录键与值内 id 逐项相等（评审第三轮修复：集合相等会放行键值
  // 置换 {a: {id: 'b'}, b: {id: 'a'}}，违反记录键为权威 id 的不变量）
  for (const [key, asset] of Object.entries(content.assets?.byId ?? {})) {
    expect(asset.id, `资产 ${key} 的值内 id 与记录键一致`).toBe(key)
  }
  for (const n of content.nodes) {
    if (n.type === 'dialogue') {
      const ids = n.data.lines.map((line) => line.id)
      expect(
        ids.every((id) => id !== ''),
        '对白行 id 非空',
      ).toBe(true)
      expect(new Set(ids).size, '对白行 id 唯一').toBe(ids.length)
    }
    if (n.type === 'branch') {
      const ids = n.data.options.map((o) => o.id)
      expect(
        ids.every((id) => id !== ''),
        '分支选项 id 非空',
      ).toBe(true)
      expect(new Set(ids).size, '分支选项 id 唯一').toBe(ids.length)
    }
    if (n.type === 'shot') {
      const ids = n.data.refs.map((r) => r.id)
      expect(
        ids.every((id) => id !== ''),
        '分镜引用位 id 非空',
      ).toBe(true)
      expect(new Set(ids).size, '分镜引用位 id 唯一').toBe(ids.length)
    }
  }
}

/** 逐边图规则（§4.4/§5，判定复用运行态 edgeKindOf——孤儿边隔离的后置
 * 条件）：端点存在、非自环、attach/branch/sequence 形态与句柄契约。 */
function assertPerEdgeRules(content: ProjectContent): void {
  const liveIds = new Set(content.nodes.map((n) => n.id))
  const nodesById = new Map(content.nodes.map((n) => [n.id, n]))
  for (const e of content.edges) {
    expect(liveIds.has(e.source), `活动边 ${e.id} 的 source 指向存在节点`).toBe(
      true,
    )
    expect(liveIds.has(e.target), `活动边 ${e.id} 的 target 指向存在节点`).toBe(
      true,
    )
    expect(e.source, `边 ${e.id} 非自环`).not.toBe(e.target)
    const src = nodesById.get(e.source)
    const dst = nodesById.get(e.target)
    const kind = edgeKindOf(e)
    if (kind === 'attach') {
      expect(e.sourceHandle, `attach 边 ${e.id} 句柄为 shots 端口`).toBe(
        SCENE_SHOT_HANDLE,
      )
      expect(src?.type, `attach 边 ${e.id} 从场景发起`).toBe('scene')
      expect(dst?.type, `attach 边 ${e.id} 挂到分镜卡`).toBe('shot')
      continue
    }
    expect(src?.type, `剧情流边 ${e.id} 不以分镜卡/图片为端点`).not.toBe('shot')
    expect(src?.type).not.toBe('image')
    expect(dst?.type, `剧情流边 ${e.id} 不以分镜卡/图片为端点`).not.toBe('shot')
    expect(dst?.type).not.toBe('image')
    if (kind === 'branch') {
      expect(src?.type, `branch 边 ${e.id} 从分支节点引出`).toBe('branch')
      const optionId = e.sourceHandle?.startsWith('option-')
        ? e.sourceHandle.slice('option-'.length)
        : undefined
      expect(
        optionId !== undefined &&
          src?.type === 'branch' &&
          src.data.options.some((o) => o.id === optionId),
        `branch 边 ${e.id} 的句柄解析到源节点的现存选项`,
      ).toBe(true)
    } else {
      expect(
        src?.type,
        `sequence 边 ${e.id} 不从分支节点匿名端口引出`,
      ).not.toBe('branch')
    }
  }
}

/** 全图边规则（§11.1 第 3 步/§11.3 隔离的后置条件）：逻辑重复元组唯一、
 * attach 宿主唯一、剧情流有向无环（attach 垂直从属不参与环检测）。 */
function assertGraphLevelRules(content: ProjectContent): void {
  const endpointKeys = content.edges.map((e) =>
    JSON.stringify([e.source, e.target, e.sourceHandle ?? '']),
  )
  expect(
    new Set(endpointKeys).size,
    '活动边端点/句柄元组唯一（无逻辑重复）',
  ).toBe(endpointKeys.length)
  const attachHosts = content.edges
    .filter((e) => edgeKindOf(e) === 'attach')
    .map((e) => e.target)
  expect(new Set(attachHosts).size, 'attach 宿主唯一').toBe(attachHosts.length)
  const flowAdj = new Map<string, string[]>()
  for (const e of content.edges) {
    if (edgeKindOf(e) === 'attach') continue
    const list = flowAdj.get(e.source)
    if (list) list.push(e.target)
    else flowAdj.set(e.source, [e.target])
  }
  const visited = new Set<string>()
  const onPath = new Set<string>()
  const hasCycle = (node: string): boolean => {
    if (onPath.has(node)) return true
    if (visited.has(node)) return false
    visited.add(node)
    onPath.add(node)
    for (const next of flowAdj.get(node) ?? []) {
      if (hasCycle(next)) return true
    }
    onPath.delete(node)
    return false
  }
  expect(
    [...flowAdj.keys()].every((start) => !hasCycle(start)),
    '剧情流边构成有向无环图',
  ).toBe(true)
}

/** 集标题契约（§4.1）：键为正整数、值为非空标题。 */
function assertEpisodeTitles(content: ProjectContent): void {
  for (const [key, title] of Object.entries(content.episodeTitles ?? {})) {
    const episode = Number(key)
    expect(
      Number.isSafeInteger(episode) && episode > 0,
      `集标题键 ${key} 为正整数`,
    ).toBe(true)
    expect(title, `集 ${key} 标题非空`).not.toBe('')
  }
}

/** 输出不变量总装（issue #232）：身份唯一、活动边满足图规则、集标题契约。 */
function assertOutputInvariants(content: ProjectContent): void {
  assertIdentityInvariants(content)
  assertPerEdgeRules(content)
  assertGraphLevelRules(content)
  assertEpisodeTitles(content)
}

describe('归一化不变量的生成式验证（issue #232）：v1 已支持信封', () => {
  it('任意脏 v1 信封：解析不抛错且输出满足身份/边/集标题不变量', () => {
    fc.assert(
      fc.property(contentArb, dirtFlagsArb, (c, dirt) => {
        const doc = v1Envelope(c, dirt)
        const round = parseProject(doc)
        assertOutputInvariants(round.content)
      }),
    )
  })

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

describe('归一化不变量的生成式验证（issue #232）：有效内容保全', () => {
  /** 干净生成器（评审第四轮：结构不变量放行「静默清空」回归，需要保全
   * 预言机）——身份确定性唯一（n0..、ch0..），下标引用保证端点/句柄落在
   * 真实节点与选项，边只从低下标指向高下标（DAG 前置）。合法记录与其
   * 内容经解析-序列化必须存活。 */
  // 保全值用受限字母表（非空、无空白、非标点）：空名/空白名/空文件名
  // 是归一化修复的合法目标，不在「原样存活」预期内（首跑即抓到
  // assets/ 空文件名与 ' ' 空白文件名被词法校验隔离）
  const nonEmptyText = fc
    .array(fc.constantFrom('a', 'b', 'c', '1', '2', '丹'), {
      minLength: 1,
      maxLength: 6,
    })
    .map((chars) => chars.join(''))
  const cleanPayloadArb = fc.record({
    sceneNames: fc.array(nonEmptyText, { maxLength: 4 }),
    dialogueTexts: fc.array(nonEmptyText, { maxLength: 2 }),
    branchOptionLabels: fc.array(fc.array(nonEmptyText, { maxLength: 3 }), {
      maxLength: 2,
    }),
    assetRelPaths: fc.array(nonEmptyText, { minLength: 1, maxLength: 3 }),
    characterNames: fc.array(nonEmptyText, { maxLength: 3 }),
    locationNames: fc.array(nonEmptyText, { maxLength: 3 }),
    propNames: fc.array(nonEmptyText, { maxLength: 3 }),
    documentTitles: fc.array(nonEmptyText, { maxLength: 3 }),
    titles: fc.array(
      fc.record({
        episode: fc.integer({ min: 1, max: 5 }),
        title: nonEmptyText,
      }),
      { maxLength: 3 },
    ),
    flowPairs: fc.array(fc.record({ from: fc.nat(5), to: fc.nat(5) }), {
      maxLength: 4,
    }),
    branchEdgeSpecs: fc.array(
      fc.record({ from: fc.nat(1), to: fc.nat(5), optionIdx: fc.nat(2) }),
      { maxLength: 2 },
    ),
  })

  /** 干净内容的组装（评审第四轮保全预言机）：确定性唯一身份 + 下标
   * 引用落位 + from<to 的 DAG 前置；返回会话内容与集标题预期。 */
  /** 干净节点组装（保全预言机）：scene/dialogue/branch，确定性唯一 id。 */
  function assembleCleanNodes(
    payload: ArbValue<typeof cleanPayloadArb>,
  ): Array<Record<string, unknown>> {
    const nodes: Array<Record<string, unknown>> = []
    payload.sceneNames.forEach((name, i) =>
      nodes.push({
        id: `n${i}`,
        type: 'scene',
        position: { x: 0, y: 0 },
        data: { name, sceneNo: 1, interior: true, synopsis: '' },
      }),
    )
    payload.dialogueTexts.forEach((text, i) =>
      nodes.push({
        id: `d${i}`,
        type: 'dialogue',
        position: { x: 0, y: 0 },
        data: {
          name: `对白${i}`,
          lines: [{ id: `l${i}`, kind: 'line', text }],
        },
      }),
    )
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
    return nodes
  }

  /** 干净边组装：from<to 的统一前向序（含 branch 边，评审第五轮——两段
   * branch 边可闭合回路，环隔离会让预期失配）；端点类型约束外的下标
   * 碰撞形态不计入保全预期。 */
  function assembleCleanEdges(
    payload: ArbValue<typeof cleanPayloadArb>,
    nodes: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    const edges: Array<Record<string, unknown>> = []
    let edgeNo = 0
    for (const pair of payload.flowPairs) {
      const src = nodes[pair.from]
      const dst = nodes[pair.to]
      if (src === undefined || dst === undefined || pair.from >= pair.to)
        continue
      if (src.type !== 'scene' || dst.type === 'branch') continue
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
      edges.push({
        id: `e${edgeNo++}`,
        source: src.id,
        target: dst.id,
        sourceHandle: `option-${options[spec.optionIdx]?.id}`,
        type: 'branch',
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
          documents: payload.documentTitles.map((title, i) => ({
            id: `doc${i}`,
            title,
            body: '正文',
            relatedIds: [],
          })),
        },
        episodeTitles: expectedTitles,
        assets: { byId: assets },
      },
      expectedTitles,
    }
  }

  /** 保全断言：合法记录与内容经解析-序列化全部存活（记录数 + 逐条内容，
   * 边按逻辑重复键去重后比对）。 */
  function assertCleanPreserved(
    payload: ArbValue<typeof cleanPayloadArb>,
    out: ProjectContent,
    expectedTitles: Record<string, string>,
    assetIds: string[],
    edgeKeys: string[],
  ): void {
    expect(out.nodes.map((n) => n.id).sort(), '节点全部存活').toEqual(
      [
        ...payload.sceneNames.map((_, i) => `n${i}`),
        ...payload.dialogueTexts.map((_, i) => `d${i}`),
        ...payload.branchOptionLabels
          .map((labels, i) => (labels.length > 0 ? `b${i}` : null))
          .filter((id): id is string => id !== null),
      ].sort(),
    )
    const sceneLabels = out.nodes
      .filter((n) => n.type === 'scene')
      .map((n) => (n.type === 'scene' ? n.data.name : ''))
    expect(sceneLabels.sort(), '场景名保全').toEqual(
      [...payload.sceneNames].sort(),
    )
    const lineTexts = out.nodes
      .filter((n) => n.type === 'dialogue')
      .flatMap((n) =>
        n.type === 'dialogue' ? n.data.lines.map((l) => l.text) : [],
      )
    expect(lineTexts.sort(), '台词文本保全').toEqual(
      [...payload.dialogueTexts].sort(),
    )
    const optionLabels = out.nodes
      .filter((n) => n.type === 'branch')
      .flatMap((n) =>
        n.type === 'branch' ? n.data.options.map((o) => o.label) : [],
      )
    expect(optionLabels.sort(), '分支选项文案保全').toEqual(
      payload.branchOptionLabels.flat().sort(),
    )
    expect(Object.keys(out.assets?.byId ?? {}).sort(), '资产全部存活').toEqual(
      assetIds.sort(),
    )
    // 设定桶保全（评审第五轮）：角色/地点名、文档标题逐条存活
    expect(
      out.settings.characters.map((c) => c.name).sort(),
      '角色名保全',
    ).toEqual([...payload.characterNames].sort())
    expect(
      out.settings.locations.map((l) => l.name).sort(),
      '地点名保全',
    ).toEqual([...payload.locationNames].sort())
    expect(
      (out.settings.props ?? []).map((e) => e.name).sort(),
      '道具名保全',
    ).toEqual([...payload.propNames].sort())
    expect(
      (out.settings.documents ?? []).map((d) => d.title).sort(),
      '设定文档标题保全',
    ).toEqual([...payload.documentTitles].sort())
    expect(out.episodeTitles, '集标题保全').toEqual(expectedTitles)
    expect(out.name, '项目名保全').toBe('保全')
    // 逻辑重复键（source/target/handle，首见胜）去重后比对——同端点重复
    // 边被隔离属合法修复
    const outEdgeKeys = [
      ...new Set(
        out.edges.map((e) =>
          JSON.stringify([e.source, e.target, e.sourceHandle ?? '']),
        ),
      ),
    ]
    expect(outEdgeKeys.sort(), '有效边全部存活').toEqual(edgeKeys.sort())
  }

  it('合法生成记录经归一化全部存活：节点/设定/资产/集标题/有效边不丢', () => {
    fc.assert(
      fc.property(cleanPayloadArb, (payload) => {
        const { content, expectedTitles } = assembleCleanContent(payload)
        const assetIds = Object.keys(content.assets?.byId ?? {})
        const edgeKeys = content.edges.map((e) =>
          JSON.stringify([e.source, e.target, e.sourceHandle ?? '']),
        )
        // 经 serializeProject 构造合法 v1 信封（与生产同款落盘路径）；
        // 手工拼 v0 扁平 data 塞进 v1 信封会被嵌套容器守卫正确隔离
        const round1 = parseProject(serializeProject(content, PROJECT_ID, NOW))
        assertCleanPreserved(
          payload,
          round1.content,
          expectedTitles,
          assetIds,
          [...new Set(edgeKeys)],
        )
      }),
    )
  })
})

describe('归一化不变量的生成式验证（issue #232）：v0 迁移与拒绝边界', () => {
  it('任意 v0 信封：迁移成功、输出满足不变量、迁移产物幂等', () => {
    fc.assert(
      fc.property(v0EnvelopeArb, (v0) => {
        // 首节点恒为 branch（选项 id 确定性唯一化），branchEdges 携带旧版
        // option-N 下标句柄从它引出（评审第四轮：下标句柄迁移路径须被行使）
        const branchNode = {
          id: 'br0',
          type: 'branch',
          position: { x: 0, y: 0 },
          data: {
            prompt: v0.branch.prompt,
            options: v0.branch.optionLabels.map((label, i) => ({
              id: `opt${i}`,
              label,
            })),
          },
        }
        // 场景 id 确定性唯一化（s0..）：空白/重复 id 会触发重发，预期按
        // 原始 id 对准就会失配
        const docNodes = [
          branchNode,
          ...v0.scenes.map((sc, i) => ({ ...sc, id: `s${i}` })),
        ]
        // 运行态判别器（评审第五轮）：缺 type: 'branch' 时迁移后被分类为
        // sequence、按「branch 节点不得引出匿名边」隔离，幸存环恒空转；
        // 目标按下标引用真实节点（悬空目标会被端点守卫隔离，不构成迁移
        // 预期），指向 br0 的自环边不生成
        const branchEdges: Array<Record<string, unknown>> = []
        v0.branchEdges.forEach((e) => {
          const target = docNodes[e.targetIdx] as { id?: unknown } | undefined
          if (target === undefined || target.id === 'br0') return
          branchEdges.push({
            // 确定性唯一 id（be0..）：空白/重复 id 会触发重发，按端点元组
            // 对准的预期就会失配
            id: `be${branchEdges.length}`,
            type: 'branch' as const,
            source: 'br0',
            target: target.id,
            sourceHandle: `option-${e.optionIdx}`,
          })
        })
        // 普通剧情流边按下标引用真实节点（评审第六轮：n* 池端点与组装后
        // 节点恒不相遇、全部被端点守卫隔离，保全路径空转）；前向序 + 源
        // 非 branch（sequence 端点约束），碰撞出的非法形态不生成
        const flowEdges: Array<Record<string, unknown>> = []
        v0.flowEdgeSpecs.forEach((spec) => {
          const src = docNodes[spec.sourceIdx] as
            { id?: unknown; type?: unknown } | undefined
          const dst = docNodes[spec.targetIdx] as { id?: unknown } | undefined
          if (src === undefined || dst === undefined) return
          if (spec.sourceIdx >= spec.targetIdx) return
          if (src.id === dst.id || src.type === 'branch') return
          flowEdges.push({
            id: `fe${flowEdges.length}`,
            source: src.id,
            target: dst.id,
          })
        })
        const doc = {
          schemaVersion: 0,
          project: {
            id: 'p-old',
            name: '旧剧',
            createdAt: '',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          graph: {
            nodes: docNodes,
            edges: [...flowEdges, ...branchEdges],
          },
          settings: { characters: v0.characters, locations: [] },
          episodeTitles: {},
          assets: { byId: {} },
        }
        const migrated = parseProject(doc)
        expect(migrated.migrated).toBe(true)
        assertOutputInvariants(migrated.content)
        // 下标句柄的迁移后置条件（评审第五轮）：在界 option-N 精确改写为
        // 第 N 个选项的 id（选项 id 确定性唯一 optN，无重发改写）；越界
        // 句柄按孤儿边隔离——幸存集合与句柄值都对准迁移意图
        // 普通剧情流边保全（评审第六轮）：合法前向序边全部幸存，端点
        // 元组按逻辑重复键去重后比对
        const expectedFlowTuples = [
          ...new Set(flowEdges.map((e) => `${e.source}→${e.target}`)),
        ].sort()
        const outFlowTuples = [
          ...new Set(
            migrated.content.edges
              .filter((e) => edgeKindOf(e) === 'sequence')
              .map((e) => `${e.source}→${e.target}`),
          ),
        ].sort()
        expect(outFlowTuples, '合法 v0 剧情流边全部存活').toEqual(
          expectedFlowTuples,
        )
        // 预期按端点元组（target + 改写后句柄）去重：同元组的重复边按逻辑
        // 重复隔离属合法修复；在界句柄精确改写为 option-opt<N>
        const optionCount = v0.branch.optionLabels.length
        const expectedTuples = new Set(
          branchEdges
            .map((e) => ({
              target: e.target as string,
              idx: Number(String(e.sourceHandle ?? '').slice('option-'.length)),
            }))
            .filter(({ idx }) => idx < optionCount)
            .map(({ target, idx }) => `${target}→option-opt${idx}`),
        )
        const outTuples = migrated.content.edges
          .filter((e) => edgeKindOf(e) === 'branch' && e.source === 'br0')
          .map((e) => `${e.target}→${e.sourceHandle}`)
        expect(
          [...new Set(outTuples)].sort(),
          '在界下标句柄精确迁移并全部幸存',
        ).toEqual([...expectedTuples].sort())
        const round2 = parseProject(
          serializeProject(migrated.content, PROJECT_ID, NOW),
        )
        expect(round2.migrated).toBe(false)
        expect(round2.repaired).toBe(false)
      }),
    )
  })

  it('允许拒绝的版本边界：过新版本显式拒绝，非法版本按损坏拒绝', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: CURRENT_SCHEMA_VERSION + 1, max: 99 }),
        fc.constantFrom(null, -1, 1.5, '1', Number.NaN, true),
        (tooNew, garbage) => {
          expect(() => parseProject({ schemaVersion: tooNew })).toThrow(
            /版本过新/,
          )
          expect(() => parseProject({ schemaVersion: garbage })).toThrow(
            TypeError,
          )
        },
      ),
    )
    expect(() => parseProject('oops')).toThrow(/损坏/)
    expect(() => parseProject(null)).toThrow(/损坏/)
  })
})
