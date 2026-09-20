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
    const data: NodeSpecGen = { kind: e.kind }
    if (e.order !== undefined) data.order = e.order
    const edge: NodeSpecGen = {
      id: e.id,
      source: e.source,
      target: e.target,
      data,
    }
    if (e.kind === 'branch') edge.sourceHandle = `option-opt${e.optionNo}`
    if (e.kind === 'attach') edge.sourceHandle = 'shots'
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
    assets: Record<string, unknown>
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
  if (dirt.badUpdatedAt) doc.project.updatedAt = 'not-a-time'
  if (dirt.graphExt !== undefined) doc.graph.futureGraphField = dirt.graphExt
  if (dirt.settingsExt !== undefined)
    doc.settings.futureSettingsField = dirt.settingsExt
  if (dirt.assetsExt !== undefined)
    doc.assets.futureAssetsField = dirt.assetsExt
  return { schemaVersion: 1, ...doc }
}

/** v0 原始信封：旧扁平形态（数组桶、position 直挂、无 meta 包裹）。 */
const v0EnvelopeArb = fc.record({
  nodes: fc.array(
    fc.oneof(
      fc.record({
        id: idArb('n'),
        type: fc.constant('scene'),
        position: fc.record({ x: finiteNumber, y: finiteNumber }),
        data: fc.record({
          name: shortText,
          sceneNo: fc.nat(3),
          interior: fc.boolean(),
          synopsis: shortText,
        }),
      }),
      fc.record({
        id: idArb('n'),
        type: fc.constant('branch'),
        position: fc.record({ x: finiteNumber, y: finiteNumber }),
        data: fc.record({
          prompt: shortText,
          options: fc.array(fc.record({ id: idArb('opt'), label: shortText }), {
            maxLength: 3,
          }),
        }),
      }),
    ),
    { maxLength: 5 },
  ),
  edges: fc.array(
    fc.record({
      id: idArb('e'),
      source: idArb('n'),
      target: idArb('n'),
    }),
    { maxLength: 4 },
  ),
  characters: fc.array(characterArb, { maxLength: 3 }),
})

/** 输出不变量（issue #232：身份唯一 + 活动边满足图规则 + 集标题契约）。 */
function assertOutputInvariants(content: ProjectContent): void {
  const nodeIds = content.nodes.map((n) => n.id)
  expect(
    nodeIds.every((id) => id !== ''),
    '节点 id 非空',
  ).toBe(true)
  expect(new Set(nodeIds).size, '节点 id 唯一').toBe(nodeIds.length)
  const edgeIds = content.edges.map((e) => e.id)
  expect(
    edgeIds.every((id) => id !== ''),
    '边 id 非空',
  ).toBe(true)
  expect(new Set(edgeIds).size, '边 id 唯一').toBe(edgeIds.length)
  const liveIds = new Set(nodeIds)
  const nodesById = new Map(content.nodes.map((n) => [n.id, n]))
  for (const e of content.edges) {
    expect(liveIds.has(e.source), `活动边 ${e.id} 的 source 指向存在节点`).toBe(
      true,
    )
    expect(liveIds.has(e.target), `活动边 ${e.id} 的 target 指向存在节点`).toBe(
      true,
    )
    // 图规则（§4.4/§5，判定复用运行态 edgeKindOf——孤儿边隔离的后置条件）
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
  for (const bucket of [
    content.settings.characters,
    content.settings.locations,
  ]) {
    const ids = bucket.map((entity) => entity.id)
    expect(new Set(ids).size, '设定桶 id 唯一').toBe(ids.length)
  }
  for (const n of content.nodes) {
    if (n.type === 'dialogue') {
      const lineIds = n.data.lines.map((line) => line.id)
      expect(new Set(lineIds).size, '对白行 id 唯一').toBe(lineIds.length)
    }
    if (n.type === 'branch') {
      const optionIds = n.data.options.map((o) => o.id)
      expect(new Set(optionIds).size, '分支选项 id 唯一').toBe(optionIds.length)
    }
  }
  for (const [key, title] of Object.entries(content.episodeTitles ?? {})) {
    const episode = Number(key)
    expect(
      Number.isSafeInteger(episode) && episode > 0,
      `集标题键 ${key} 为正整数`,
    ).toBe(true)
    expect(title, `集 ${key} 标题非空`).not.toBe('')
  }
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
        for (const [field, spot, ext] of [
          ['futureGraphField', again.graph, round.content.graphExtensions],
          [
            'futureSettingsField',
            again.settings,
            round.content.settingsExtensions,
          ],
          ['futureAssetsField', again.assets, round.content.assetsExtensions],
        ] as const) {
          if (dirt[field as 'graphExt'] !== undefined) {
            expect(ext?.[field]).toEqual(dirt[field as 'graphExt'])
            expect(spot[field]).toEqual(dirt[field as 'graphExt'])
          }
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

describe('归一化不变量的生成式验证（issue #232）：v0 迁移与拒绝边界', () => {
  it('任意 v0 信封：迁移成功、输出满足不变量、迁移产物幂等', () => {
    fc.assert(
      fc.property(v0EnvelopeArb, (v0) => {
        const doc = {
          schemaVersion: 0,
          project: {
            id: 'p-old',
            name: '旧剧',
            createdAt: '',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          graph: { nodes: v0.nodes, edges: v0.edges },
          settings: { characters: v0.characters, locations: [] },
          episodeTitles: {},
          assets: { byId: {} },
        }
        const migrated = parseProject(doc)
        expect(migrated.migrated).toBe(true)
        assertOutputInvariants(migrated.content)
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
